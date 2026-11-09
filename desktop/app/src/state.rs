use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rune::TextEdit;
use rune_kit::{FileNode, FileTree, TreeModel};

use crate::core::agent::{Activity, AgentHandle, SharedView, TicketView, spawn_agent, Launch};
use crate::core::config::{Config, read_config};
use crate::core::files::{FileDocument, FileKind, Store};
use crate::core::settings::{Settings, read_settings, write_settings};
use crate::core::tickets::{Ticket, discover_tickets};

pub struct AgentRuntime {
    pub handle: AgentHandle,
    pub view: SharedView,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SaveStatus {
    Saved,
    Unsaved,
    Conflict,
    Failed(String),
}

impl SaveStatus {
    pub fn label(&self) -> String {
        match self {
            SaveStatus::Saved => "Saved".into(),
            SaveStatus::Unsaved => "Unsaved".into(),
            SaveStatus::Conflict => "Conflict".into(),
            SaveStatus::Failed(message) => format!("Save failed: {message}"),
        }
    }
}

pub struct AppState {
    pub tickets: Vec<Ticket>,
    pub active: usize,
    pub agents: HashMap<String, AgentRuntime>,
    pub files: Vec<FileEntryRow>,
    pub tree: TreeModel<FileNode<()>>,
    pub document: Option<FileDocument>,
    pub composer: TextEdit,
    pub editor: TextEdit,
    pub editing: bool,
    pub status: SaveStatus,
    pub conflict: Option<FileDocument>,
    pub pending_save: Option<f64>,
    pub clock: f64,
    pub config: Config,
    pub settings: Settings,
    pub data_dir: PathBuf,
    pub settings_path: PathBuf,
    pub dirty: Arc<AtomicBool>,
    pub error: Option<String>,
    pub session_width: f32,
    pub tree_width: f32,
}

#[derive(Clone)]
pub struct FileEntryRow {
    pub path: String,
    pub size: u64,
}

impl AppState {
    pub fn init() -> AppState {
        let data_dir = std::env::var("SUPPORT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("APPDATA")
                    .map(|appdata| PathBuf::from(appdata).join("support-workspace"))
                    .unwrap_or_else(|_| PathBuf::from("."))
            });
        let root = std::env::var("SUPPORT_TICKETS_ROOT")
            .map(PathBuf::from)
            .ok()
            .or_else(|| read_settings(&data_dir.join("settings.json")).ok().and_then(|settings| settings.root.map(PathBuf::from)))
            .unwrap_or_else(|| PathBuf::from("tickets"));
        AppState::from_dirs(data_dir, root)
    }

    pub fn from_dirs(data_dir: PathBuf, root: PathBuf) -> AppState {
        let settings_path = data_dir.join("settings.json");
        let settings = read_settings(&settings_path).unwrap_or_default();
        let (config, config_error) = match read_config(&data_dir) {
            Ok(config) => (config, None),
            Err(error) => (Config::default(), Some(error.message)),
        };
        let store = Store::new(data_dir.clone());
        let mut tickets = discover_tickets(&root, &data_dir).unwrap_or_default();
        let dirty = Arc::new(AtomicBool::new(false));
        let mut agents = HashMap::new();
        for ticket in &tickets {
            let wake = {
                let dirty = dirty.clone();
                move || {
                    dirty.store(true, Ordering::SeqCst);
                }
            };
            match spawn_agent(ticket.clone(), data_dir.clone(), store.clone(), Launch::copilot(), Box::new(wake)) {
                Ok((handle, view)) => {
                    agents.insert(ticket.id.clone(), AgentRuntime { handle, view });
                }
                Err(error) => {
                    agents.clear();
                    return AppState {
                        tickets: Vec::new(),
                        active: 0,
                        agents,
                        files: Vec::new(),
                        tree: FileTree::new().build(Vec::<(String, ())>::new()),
                        document: None,
                        composer: TextEdit::new(""),
                        editor: TextEdit::new(""),
                        editing: false,
                        status: SaveStatus::Saved,
                        conflict: None,
                        pending_save: None,
                        clock: 0.0,
                        config,
                        settings,
                        data_dir,
                        settings_path,
                        dirty,
                        error: Some(error.message),
                        session_width: 380.0,
                        tree_width: 260.0,
                    };
                }
            }
        }
        let active = settings
            .last_ticket_id
            .as_ref()
            .and_then(|id| tickets.iter().position(|ticket| &ticket.id == id))
            .unwrap_or(0);
        let session_width = config.pane_widths.map(|widths| widths.session).unwrap_or(380.0);
        let tree_width = config.pane_widths.map(|widths| widths.tree).unwrap_or(260.0);
        let mut state = AppState {
            tickets: std::mem::take(&mut tickets),
            active,
            agents,
            files: Vec::new(),
            tree: FileTree::new().build(Vec::<(String, ())>::new()),
            document: None,
            composer: TextEdit::new(""),
            editor: TextEdit::new(""),
            editing: false,
            status: SaveStatus::Saved,
            conflict: None,
            pending_save: None,
            clock: 0.0,
            config,
            settings,
            data_dir,
            settings_path,
            dirty,
            error: config_error,
            session_width,
            tree_width,
        };
        if !state.tickets.is_empty() {
            state.select_ticket(state.active);
        }
        state
    }

    pub fn ticket(&self) -> Option<&Ticket> {
        self.tickets.get(self.active)
    }

    pub fn agent(&self) -> Option<&AgentRuntime> {
        self.ticket().and_then(|ticket| self.agents.get(&ticket.id))
    }

    pub fn view(&self) -> Option<std::sync::MutexGuard<'_, TicketView>> {
        self.agent().map(|agent| agent.view.lock().unwrap())
    }

    pub fn select_ticket(&mut self, index: usize) {
        if index >= self.tickets.len() {
            return;
        }
        if !self.flush() {
            self.error = Some("Resolve the current save or conflict before switching tickets.".into());
            return;
        }
        self.active = index;
        let ticket = self.tickets[index].clone();
        let store = Store::new(self.data_dir.clone());
        self.files = store
            .files(&ticket)
            .map(|files| files.into_iter().map(|file| FileEntryRow { path: file.path, size: file.size }).collect())
            .unwrap_or_default();
        let paths: Vec<String> = self.files.iter().map(|file| file.path.replace('\\', "/")).collect();
        self.tree = FileTree::new().build(paths.into_iter().map(|path| (path, ())));
        self.tree.expand_all();
        let main = ticket
            .main_file
            .clone()
            .or_else(|| self.files.first().map(|file| file.path.clone()));
        if let Some(main) = main {
            self.open_file(&main);
        } else {
            self.document = None;
        }
        self.settings.last_ticket_id = Some(ticket.id.clone());
        let _ = write_settings(&self.settings_path, &self.settings);
    }

    pub fn open_file(&mut self, relative: &str) {
        let Some(ticket) = self.ticket().cloned() else { return };
        if !self.flush() {
            self.error = Some("Resolve the current save or conflict before opening another file.".into());
            return;
        }
        let store = Store::new(self.data_dir.clone());
        let normalized = relative.replace('/', "\\");
        match store.read(&ticket, &normalized) {
            Ok(document) => {
                self.editor = TextEdit::new(document.content.clone());
                self.document = Some(document);
                self.editing = false;
                self.conflict = None;
                self.pending_save = None;
                self.status = SaveStatus::Saved;
                self.error = None;
                self.tree.select(relative);
            }
            Err(error) => self.error = Some(error.message),
        }
    }

    pub fn toggle_editing(&mut self) {
        if self.document_kind() != Some(FileKind::Markdown) {
            return;
        }
        if self.editing {
            if self.flush() {
                self.editing = false;
            }
        } else {
            self.editor = TextEdit::new(self.document_text());
            self.editing = true;
            self.conflict = None;
            self.status = SaveStatus::Saved;
        }
    }

    pub fn editor_changed(&mut self) {
        if self.conflict.is_some() {
            return;
        }
        self.status = SaveStatus::Unsaved;
        self.pending_save = Some(self.clock + 0.6);
    }

    pub fn poll_saves(&mut self, clock: f64) -> bool {
        self.clock = clock;
        if self.pending_save.is_some_and(|at| at <= clock) {
            self.pending_save = None;
            return self.save();
        }
        false
    }

    pub fn save(&mut self) -> bool {
        let (Some(ticket), Some(document)) = (self.ticket().cloned(), self.document.clone()) else {
            return true;
        };
        if !self.editing || self.conflict.is_some() {
            return self.conflict.is_none();
        }
        let store = Store::new(self.data_dir.clone());
        match store.save(&ticket, &document.path, &self.editor.text, &document.revision) {
            Ok(saved) => {
                self.document = Some(saved);
                self.status = SaveStatus::Saved;
                true
            }
            Err(error) if error.code == "CONFLICT" => {
                self.conflict = store.read(&ticket, &document.path).ok();
                self.status = SaveStatus::Conflict;
                false
            }
            Err(error) => {
                self.status = SaveStatus::Failed(error.message);
                false
            }
        }
    }

    pub fn use_disk(&mut self) {
        if let Some(disk) = self.conflict.clone() {
            self.editor = TextEdit::new(disk.content.clone());
            self.document = Some(disk);
            self.conflict = None;
            self.pending_save = None;
            self.status = SaveStatus::Saved;
        }
    }

    pub fn keep_mine(&mut self) {
        let (Some(ticket), Some(document), Some(conflict)) =
            (self.ticket().cloned(), self.document.clone(), self.conflict.clone())
        else {
            return;
        };
        let store = Store::new(self.data_dir.clone());
        match store.save(&ticket, &document.path, &self.editor.text, &conflict.revision) {
            Ok(saved) => {
                self.document = Some(saved);
                self.conflict = None;
                self.pending_save = None;
                self.status = SaveStatus::Saved;
            }
            Err(error) => self.status = SaveStatus::Failed(error.message),
        }
    }

    pub fn flush(&mut self) -> bool {
        if self.conflict.is_some() {
            return false;
        }
        if self.status == SaveStatus::Unsaved {
            return self.save();
        }
        true
    }

    pub fn insert_message(&mut self, text: &str) {
        if self.document_kind() != Some(FileKind::Markdown) {
            return;
        }
        if !self.editing {
            self.editor = TextEdit::new(self.document_text());
            self.editing = true;
        }
        let mut next = self.editor.text.clone();
        next.push_str("\n\n");
        next.push_str(text);
        self.editor.replace_text(next);
        self.status = SaveStatus::Unsaved;
        self.pending_save = Some(self.clock + 0.6);
    }

    pub fn open_link(&mut self, target: &str) {
        if target.is_empty() || target.starts_with('#') {
            return;
        }
        if target.starts_with("http://") || target.starts_with("https://") {
            let _ = std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn();
            return;
        }
        let parent = self
            .document
            .as_ref()
            .and_then(|document| document.path.rfind('\\').map(|index| document.path[..=index].to_string()))
            .unwrap_or_default();
        let clean = target.split('#').next().unwrap_or("").replace('/', "\\");
        self.open_file(&format!("{parent}{clean}"));
    }

    pub fn agent_editing(&self) -> bool {
        let (Some(ticket), Some(document)) = (self.ticket(), self.document.as_ref()) else {
            return false;
        };
        let absolute = format!("{}\\{}", ticket.root.display(), document.path).replace('/', "\\").to_lowercase();
        self.tools().iter().any(|tool| {
            tool.kind == "edit"
                && (tool.status == "pending" || tool.status == "in_progress")
                && tool.paths.iter().any(|path| path.replace('/', "\\").to_lowercase() == absolute)
        })
    }

    pub fn document_text(&self) -> String {
        self.document.as_ref().map(|document| document.content.clone()).unwrap_or_default()
    }

    pub fn document_kind(&self) -> Option<FileKind> {
        self.document.as_ref().map(|document| document.kind)
    }

    pub fn submit(&mut self) {
        let text = self.composer.text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if let Some(agent) = self.agent() {
            agent.handle.send(text);
            self.composer = TextEdit::new("");
        }
    }

    pub fn activity_label(&self) -> &'static str {
        match self.view().map(|view| view.activity) {
            Some(Activity::Starting) => "Connecting",
            Some(Activity::Running) => "Working",
            Some(Activity::Approval) => "Approval needed",
            Some(Activity::Completed) => "Completed",
            Some(Activity::Failed) => "Needs attention",
            _ => "Ready",
        }
    }

    pub fn session_visible(&mut self, index: usize) -> bool {
        index < self.tickets.len()
    }

    pub fn discovered(&self) -> Vec<crate::core::agent::SessionSummary> {
        self.view().map(|view| view.discovered.clone()).unwrap_or_default()
    }

    pub fn unattached_sessions(&self) -> Vec<crate::core::agent::SessionSummary> {
        let Some(view) = self.view() else { return Vec::new() };
        let attached: std::collections::HashSet<&str> = view
            .history
            .conversations
            .iter()
            .filter_map(|conversation| conversation.session_id.as_deref())
            .collect();
        view.discovered
            .iter()
            .filter(|summary| !attached.contains(summary.session_id.as_str()))
            .cloned()
            .collect()
    }

    pub fn approvals(&self) -> Vec<crate::core::agent::Approval> {
        self.view().map(|view| view.approvals.clone()).unwrap_or_default()
    }

    pub fn messages(&self) -> Vec<crate::core::history::Message> {
        self.view().map(|view| view.messages().to_vec()).unwrap_or_default()
    }

    pub fn tools(&self) -> Vec<crate::core::agent::ToolActivity> {
        self.view().map(|view| view.tools.clone()).unwrap_or_default()
    }

    pub fn ticket_activity(&self, index: usize) -> Activity {
        self.tickets
            .get(index)
            .and_then(|ticket| self.agents.get(&ticket.id))
            .map(|agent| agent.view.lock().unwrap().activity)
            .unwrap_or(Activity::Idle)
    }
}


