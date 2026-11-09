use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};

use super::acp::AcpClient;
use super::error::{Error, Result};
use super::files::{Lease, Store};
use super::history::{Conversation, History, Message, load_history, save_history};
use super::tickets::{Ticket, resolve};

pub const CLI_ARGS: &[&str] = &[
    "--acp", "--stdio", "--disable-builtin-mcps", "--disallow-temp-dir",
    "--no-custom-instructions", "--no-auto-update", "--dynamic-retrieval", "skills=off",
];

#[derive(Debug, Clone)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
}

impl Launch {
    pub fn copilot() -> Self {
        Launch { command: cli_command(), args: CLI_ARGS.iter().map(|arg| arg.to_string()).collect() }
    }

    pub fn new(command: impl Into<String>, args: &[&str]) -> Self {
        Launch { command: command.into(), args: args.iter().map(|arg| arg.to_string()).collect() }
    }

    fn spawn(&self, cwd: &Path, home: &Path) -> Result<AcpClient> {
        let args: Vec<&str> = self.args.iter().map(String::as_str).collect();
        AcpClient::spawn(&self.command, &args, cwd, home, &[])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Idle,
    Starting,
    Running,
    Approval,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolActivity {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub options: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TicketView {
    pub activity: Activity,
    pub history: History,
    pub tools: Vec<ToolActivity>,
    pub approvals: Vec<Approval>,
    pub discovered: Vec<SessionSummary>,
    pub error: Option<String>,
}

impl TicketView {
    pub fn new(history: History) -> Self {
        TicketView {
            activity: Activity::Idle,
            history,
            tools: Vec::new(),
            approvals: Vec::new(),
            discovered: Vec::new(),
            error: None,
        }
    }

    pub fn messages(&self) -> &[Message] {
        self.history.current().map(|conversation| conversation.messages.as_slice()).unwrap_or(&[])
    }
}

pub type SharedView = Arc<Mutex<TicketView>>;

#[derive(Debug)]
pub enum AgentCommand {
    Send(String),
    Stop,
    NewConversation,
    SelectConversation(String),
    Discover,
    Attach(String),
    Approve { approval_id: String, option_id: Option<String> },
    Shutdown,
}

pub struct AgentHandle {
    commands: mpsc::Sender<AgentCommand>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl AgentHandle {
    pub fn send(&self, text: impl Into<String>) {
        let _ = self.commands.send(AgentCommand::Send(text.into()));
    }
    pub fn stop(&self) {
        let _ = self.commands.send(AgentCommand::Stop);
    }
    pub fn new_conversation(&self) {
        let _ = self.commands.send(AgentCommand::NewConversation);
    }
    pub fn select_conversation(&self, id: impl Into<String>) {
        let _ = self.commands.send(AgentCommand::SelectConversation(id.into()));
    }
    pub fn discover(&self) {
        let _ = self.commands.send(AgentCommand::Discover);
    }
    pub fn attach(&self, session_id: impl Into<String>) {
        let _ = self.commands.send(AgentCommand::Attach(session_id.into()));
    }
    pub fn approve(&self, approval_id: impl Into<String>, option_id: Option<String>) {
        let _ = self.commands.send(AgentCommand::Approve { approval_id: approval_id.into(), option_id });
    }
    pub fn shutdown(mut self) {
        let _ = self.commands.send(AgentCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for AgentHandle {
    fn drop(&mut self) {
        let _ = self.commands.send(AgentCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn history_path(data_dir: &Path, ticket: &Ticket) -> PathBuf {
    data_dir.join("tickets").join(&ticket.id).join("history.json")
}

pub fn spawn_agent(
    ticket: Ticket,
    data_dir: PathBuf,
    store: Store,
    launch: Launch,
    wake: impl Fn() + Send + Sync + 'static,
) -> Result<(AgentHandle, SharedView)> {
    let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(wake);
    let view = Arc::new(Mutex::new(TicketView::new(load_history(&history_path(&data_dir, &ticket))?)));
    let (sender, receiver) = mpsc::channel();
    let worker_view = view.clone();
    let worker = std::thread::spawn(move || {
        let mut worker = Worker {
            ticket,
            data_dir,
            store,
            launch,
            view: worker_view,
            wake,
            client: None,
            session_id: None,
            can_list: false,
            discovered: Vec::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            leases: Arc::new(Mutex::new(HashMap::new())),            capturing: Arc::new(AtomicBool::new(false)),
            loading: Arc::new(AtomicBool::new(false)),
        };
        for command in receiver {
            let shutdown = matches!(command, AgentCommand::Shutdown);
            if let Err(error) = worker.handle(command) {
                if matches!(error.code, "BUSY" | "SESSION" | "APPROVAL" | "PROMPT") {
                    let mut view = worker.view.lock().unwrap();
                    view.error = Some(error.message);
                    drop(view);
                    worker.publish();
                } else {
                    worker.fail(error);
                }
            }
            if shutdown {
                break;
            }
        }
        if let Some(client) = worker.client.take() {
            client.close();
        }
    });
    Ok((AgentHandle { commands: sender, worker: Some(worker) }, view))
}

struct Worker {
    ticket: Ticket,
    data_dir: PathBuf,
    store: Store,
    launch: Launch,
    view: SharedView,
    wake: Arc<dyn Fn() + Send + Sync>,
    client: Option<Arc<AcpClient>>,
    session_id: Option<String>,
    can_list: bool,
    discovered: Vec<SessionSummary>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Option<String>>>>>,
    leases: Arc<Mutex<HashMap<String, Vec<Lease>>>>,
    capturing: Arc<AtomicBool>,
    loading: Arc<AtomicBool>,
}

impl Worker {
    fn handle(&mut self, command: AgentCommand) -> Result<()> {
        match command {
            AgentCommand::Send(text) => self.prompt(text),
            AgentCommand::Stop => self.stop(),
            AgentCommand::NewConversation => {
                self.disconnect();
                self.push_conversation(None);
                Ok(())
            }
            AgentCommand::SelectConversation(id) => {
                self.disconnect();
                let mut view = self.view.lock().unwrap();
                let exists = view.history.conversations.iter().any(|conversation| conversation.id == id);
                if !exists {
                    return Err(Error::new("SESSION", "Unknown conversation."));
                }
                view.history.current_id = Some(id);
                drop(view);
                self.persist()
            }
            AgentCommand::Discover => self.discover(),
            AgentCommand::Attach(session_id) => self.attach(session_id),
            AgentCommand::Approve { approval_id, option_id } => {
                let sender = self.pending.lock().unwrap().remove(&approval_id);
                if let Some(sender) = sender {
                    let _ = sender.send(option_id);
                    let mut view = self.view.lock().unwrap();
                    view.approvals.retain(|approval| approval.id != approval_id);
                    view.activity = if view.approvals.is_empty() { Activity::Running } else { Activity::Approval };
                    drop(view);
                    self.publish();
                    Ok(())
                } else {
                    Err(Error::new("APPROVAL", "This permission request is no longer active."))
                }
            }
            AgentCommand::Shutdown => {
                self.disconnect();
                Ok(())
            }
        }
    }

    fn publish(&self) {
        (self.wake)();
    }

    fn fail(&self, error: Error) {
        let mut view = self.view.lock().unwrap();
        view.activity = Activity::Failed;
        view.error = Some(error.message);
        view.approvals.clear();
        drop(view);
        self.publish();
    }

    fn persist(&mut self) -> Result<()> {
        let history = self.view.lock().unwrap().history.clone();
        save_history(&history_path(&self.data_dir, &self.ticket), &history)
    }

    fn push_conversation(&mut self, session_id: Option<String>) {
        let mut view = self.view.lock().unwrap();
        let conversation = Conversation {
            id: uuid_like(),
            created_at: timestamp(),
            title: None,
            session_id,
            messages: Vec::new(),
        };
        view.history.current_id = Some(conversation.id.clone());
        view.history.conversations.push(conversation);
        view.tools.clear();
        view.approvals.clear();
        view.error = None;
        view.activity = Activity::Idle;
        drop(view);
        let _ = self.persist();
        self.publish();
    }

    fn ensure_conversation(&mut self) -> Conversation {
        let mut view = self.view.lock().unwrap();
        if view.history.current().is_none() {
            let conversation = Conversation {
                id: uuid_like(),
                created_at: timestamp(),
                title: None,
                session_id: None,
                messages: Vec::new(),
            };
            view.history.current_id = Some(conversation.id.clone());
            view.history.conversations.push(conversation);
        }
        view.history.current().cloned().unwrap()
    }

    fn connect(&mut self, load: Option<&str>) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let home = self.data_dir.join("tickets").join(&self.ticket.id).join("copilot");
        let client = self.launch.spawn(&self.ticket.root, &home)?;
        let view = self.view.clone();
        let wake = self.wake.clone();
        let leases = self.leases.clone();
        let loading = self.loading.clone();
        let capturing = self.capturing.clone();
        client.on_notification(Box::new(move |message: Value| {
            if loading.load(Ordering::SeqCst) && !capturing.load(Ordering::SeqCst) {
                return;
            }
            let update = message.get("params").and_then(|params| params.get("update")).cloned();
            let Some(update) = update else { return };
            let mut view = view.lock().unwrap();
            apply_update(&mut view, &update, &leases);
            drop(view);
            wake();
        }));
        let pending = self.pending.clone();
        let view = self.view.clone();
        let wake = self.wake.clone();
        let store = self.store.clone();
        let ticket = self.ticket.clone();
        let leases = self.leases.clone();
        client.on_permission(Box::new(move |message: Value| {
            permission(&ticket, &store, &view, &pending, &leases, &wake, &message)
        }));
        let initialized = client.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": { "name": "suppai", "version": "0.1.0" }
            }),
        )?;
        if initialized["agentCapabilities"]["loadSession"].as_bool() != Some(true) {
            client.close();
            return Err(Error::new("CAPABILITY", "This Copilot CLI cannot restore ACP sessions. Update the CLI."));
        }
        self.can_list = initialized["sessionCapabilities"]["list"].is_object()
            || initialized["agentCapabilities"]["sessionCapabilities"]["list"].is_object();
        match load {
            Some(session_id) => {
                let captured = {
                    let view = self.view.lock().unwrap();
                    view.messages().is_empty()
                };
                self.capturing.store(captured, Ordering::SeqCst);
                self.loading.store(true, Ordering::SeqCst);
                let loaded = client.request(
                    "session/load",
                    json!({ "sessionId": session_id, "cwd": self.ticket.root, "mcpServers": [] }),
                );
                self.loading.store(false, Ordering::SeqCst);
                self.capturing.store(false, Ordering::SeqCst);
                if let Err(error) = loaded {
                    client.close();
                    self.session_id = None;
                    return Err(error);
                }
                self.session_id = Some(session_id.to_string());
            }
            None => {
                let session = client.request("session/new", json!({ "cwd": self.ticket.root, "mcpServers": [] }))?;
                let session_id = session["sessionId"]
                    .as_str()
                    .ok_or_else(|| Error::new("ACP", "The CLI did not return a session id."))?
                    .to_string();
                self.session_id = Some(session_id.clone());
                let mut view = self.view.lock().unwrap();
                if let Some(conversation) = view.history.current_mut() {
                    conversation.session_id = Some(session_id);
                }
                drop(view);
                let _ = self.persist();
            }
        }
        self.client = Some(Arc::new(client));
        Ok(())
    }

    fn prompt(&mut self, text: String) -> Result<()> {
        if text.trim().is_empty() {
            return Err(Error::new("PROMPT", "Enter a message."));
        }
        {
            let mut view = self.view.lock().unwrap();
            if [Activity::Starting, Activity::Running, Activity::Approval].contains(&view.activity) {
                return Err(Error::new("BUSY", "This ticket already has an active turn."));
            }
            view.activity = Activity::Starting;
            view.error = None;
            view.tools.clear();
        }
        self.publish();
        let conversation = self.ensure_conversation();
        let load = conversation.session_id.clone();
        self.connect(load.as_deref())?;
        let Some(session_id) = self.session_id.clone() else {
            return Err(Error::new("SESSION", "Copilot did not start a session."));
        };
        {
            let mut view = self.view.lock().unwrap();
            if let Some(conversation) = view.history.current_mut() {
                conversation.messages.push(Message { id: uuid_like(), role: "user".into(), text: text.clone() });
                if conversation.title.is_none() {
                    conversation.title = Some(text.chars().take(60).collect());
                }
            }
            view.activity = Activity::Running;
        }
        self.persist()?;
        self.publish();
        let prompt = format!(
            "Support ticket workspace: {}\nMain summary: {}\nUse only this ticket's evidence unless an external operation is explicitly approved. Keep findings grounded in the files. Reread files before editing if they may have changed. Do not access other support tickets automatically.\n\n{}",
            self.ticket.root.display(),
            self.ticket.main_file.clone().unwrap_or_else(|| "Select the ticket summary explicitly.".into()),
            text
        );
        let client = self.client.as_ref().expect("connected").clone();
        let view = self.view.clone();
        let wake = self.wake.clone();
        let history = history_path(&self.data_dir, &self.ticket);
        std::thread::spawn(move || {
            let result = client.request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": prompt }] }),
            );
            let mut guard = view.lock().unwrap();
            match result {
                Ok(result) => {
                    let stop_reason = result["stopReason"].as_str().unwrap_or("unknown").to_string();
                    guard.activity = if stop_reason == "cancelled" { Activity::Idle } else { Activity::Completed };
                    if stop_reason != "end_turn" && stop_reason != "cancelled" {
                        if let Some(conversation) = guard.history.current_mut() {
                            conversation.messages.push(Message {
                                id: uuid_like(),
                                role: "notice".into(),
                                text: format!("Copilot stopped: {stop_reason}"),
                            });
                        }
                    }
                }
                Err(error) => {
                    guard.activity = Activity::Failed;
                    guard.error = Some(error.message);
                    guard.approvals.clear();
                }
            }
            for tool in &mut guard.tools {
                if tool.status == "pending" || tool.status == "in_progress" {
                    tool.status = "interrupted".into();
                }
            }
            let snapshot = guard.history.clone();
            drop(guard);
            let _ = save_history(&history, &snapshot);
            wake();
        });
        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        if let (Some(client), Some(session_id)) = (&self.client, &self.session_id) {
            client.notify("session/cancel", json!({ "sessionId": session_id }))?;
        }
        let mut view = self.view.lock().unwrap();
        for sender in self.pending.lock().unwrap().drain() {
            let _ = sender.1.send(None);
        }
        view.approvals.clear();
        if [Activity::Starting, Activity::Running, Activity::Approval].contains(&view.activity) {
            view.activity = Activity::Idle;
        }
        drop(view);
        self.publish();
        Ok(())
    }

    fn discover(&mut self) -> Result<()> {
        if self.client.is_none() {
            let home = self.data_dir.join("tickets").join(&self.ticket.id).join("copilot");
            let client = self.launch.spawn(&self.ticket.root, &home)?;
            let initialized = client.request(
                "initialize",
                json!({ "protocolVersion": 1, "clientCapabilities": {}, "clientInfo": { "name": "suppai", "version": "0.1.0" } }),
            )?;
            let can_list = initialized["sessionCapabilities"]["list"].is_object()
                || initialized["agentCapabilities"]["sessionCapabilities"]["list"].is_object();
            let found = if can_list {
                client.request("session/list", json!({ "cwd": self.ticket.root }))?
            } else {
                json!({ "sessions": [] })
            };
            client.close();
            drop(client);
            self.record_discovered(&found);
            return Ok(());
        }
        if !self.can_list {
            self.record_discovered(&json!({ "sessions": [] }));
            return Ok(());
        }
        let found = self
            .client
            .as_ref()
            .unwrap()
            .request("session/list", json!({ "cwd": self.ticket.root }))?;
        self.record_discovered(&found);
        Ok(())
    }

    fn record_discovered(&mut self, found: &Value) {
        let root = self.ticket.root.to_string_lossy().to_lowercase();
        let mut sessions: Vec<SessionSummary> = found["sessions"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter(|item| {
                        item["cwd"]
                            .as_str()
                            .map(|cwd| cwd.replace('/', "\\").to_lowercase() == root)
                            .unwrap_or(false)
                    })
                    .filter_map(|item| {
                        Some(SessionSummary {
                            session_id: item["sessionId"].as_str()?.to_string(),
                            title: item["title"].as_str().map(str::to_string),
                            updated_at: item["updatedAt"].as_str().map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        self.discovered = sessions.clone();
        let mut view = self.view.lock().unwrap();
        view.discovered = sessions;
        drop(view);
        self.publish();
    }

    fn attach(&mut self, session_id: String) -> Result<()> {
        {
            let view = self.view.lock().unwrap();
            if [Activity::Starting, Activity::Running, Activity::Approval].contains(&view.activity) {
                return Err(Error::new("BUSY", "Stop the active turn before attaching a session."));
            }
            if view.history.conversations.iter().any(|conversation| conversation.session_id.as_deref() == Some(session_id.as_str())) {
                return Err(Error::new("SESSION", "That session is already attached to this ticket."));
            }
        }
        let summary = self
            .discovered
            .iter()
            .find(|summary| summary.session_id == session_id)
            .cloned()
            .ok_or_else(|| Error::new("SESSION", "Find this ticket's Copilot sessions again before attaching."))?;
        self.disconnect();
        let previous = {
            let view = self.view.lock().unwrap();
            (view.history.current_id.clone(), view.history.conversations.len())
        };
        {
            let mut view = self.view.lock().unwrap();
            view.activity = Activity::Starting;
            let conversation = Conversation {
                id: uuid_like(),
                created_at: summary.updated_at.clone().unwrap_or_else(timestamp),
                title: summary.title.clone(),
                session_id: Some(session_id.clone()),
                messages: Vec::new(),
            };
            view.history.current_id = Some(conversation.id.clone());
            view.history.conversations.push(conversation);
        }
        self.publish();
        match self.connect(Some(&session_id)) {
            Ok(()) => {
                let mut view = self.view.lock().unwrap();
                view.activity = Activity::Idle;
                drop(view);
                self.persist()?;
                self.publish();
                Ok(())
            }
            Err(error) => {
                let mut view = self.view.lock().unwrap();
                view.history.conversations.truncate(previous.1);
                view.history.current_id = previous.0;
                view.activity = Activity::Idle;
                drop(view);
                let _ = self.persist();
                self.publish();
                Err(error)
            }
        }
    }

    fn disconnect(&mut self) {
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(None);
        }
        if let Some(client) = self.client.take() {
            client.close();
        }
        self.session_id = None;
        self.can_list = false;
    }
}

fn apply_update(view: &mut TicketView, update: &Value, leases: &Arc<Mutex<HashMap<String, Vec<Lease>>>>) {
    let kind = update["sessionUpdate"].as_str().unwrap_or("");
    match kind {
        "agent_message_chunk" | "user_message_chunk" => {
            let Some(text) = update["content"]["text"].as_str() else { return };
            let role = if kind == "user_message_chunk" { "user" } else { "agent" };
            let Some(conversation) = view.history.current_mut() else { return };
            if let Some(last) = conversation.messages.last_mut() {
                if last.role == role {
                    last.text.push_str(text);
                    return;
                }
            }
            conversation.messages.push(Message { id: uuid_like(), role: role.into(), text: text.to_string() });
        }
        "tool_call" | "tool_call_update" => {
            let id = update["toolCallId"].as_str().unwrap_or("").to_string();
            let existing = view.tools.iter().position(|tool| tool.id == id);
            let status = update["status"].as_str().unwrap_or("pending").to_string();
            let paths: Vec<String> = update["locations"]
                .as_array()
                .map(|items| {
                    items.iter().filter_map(|item| item["path"].as_str().map(str::to_string)).collect()
                })
                .unwrap_or_default();
            match existing {
                Some(index) => {
                    let tool = &mut view.tools[index];
                    if let Some(title) = update["title"].as_str() {
                        tool.title = title.to_string();
                    }
                    if !paths.is_empty() {
                        tool.paths = paths;
                    }
                    tool.status = status.clone();
                }
                None => view.tools.push(ToolActivity {
                    id: id.clone(),
                    title: update["title"].as_str().unwrap_or("Copilot operation").to_string(),
                    kind: update["kind"].as_str().unwrap_or("other").to_string(),
                    status: status.clone(),
                    paths,
                }),
            }
            if status == "completed" || status == "failed" {
                leases.lock().unwrap().remove(&id);
            }
        }
        _ => {}
    }
}

fn permission(
    ticket: &Ticket,
    store: &Store,
    view: &SharedView,
    pending: &Arc<Mutex<HashMap<String, mpsc::Sender<Option<String>>>>>,
    leases: &Arc<Mutex<HashMap<String, Vec<Lease>>>>,
    wake: &Arc<dyn Fn() + Send + Sync>,
    message: &Value,
) -> Value {
    let params = &message["params"];
    let tool_call = &params["toolCall"];
    let kind = tool_call["kind"].as_str().unwrap_or("other");
    let paths: Vec<String> = tool_call["locations"]
        .as_array()
        .map(|items| items.iter().filter_map(|item| item["path"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let allow = params["options"]
        .as_array()
        .and_then(|options| options.iter().find(|option| option["kind"] == "allow_once"))
        .cloned();
    let local = paths.iter().all(|path| {
        Path::new(path)
            .strip_prefix(&ticket.root)
            .ok()
            .map(|relative| resolve(ticket, &relative.to_string_lossy(), true).is_ok())
            .unwrap_or(false)
    });
    if let Some(allow) = allow.clone() {
        if !paths.is_empty() && local && (kind == "edit" || kind == "read") {
            if kind == "edit" {
                let targets: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
                match store.begin_agent_edit(ticket, &targets, &HashMap::new()) {
                    Ok(lease) => {
                        leases
                            .lock()
                            .unwrap()
                            .entry(tool_call["toolCallId"].as_str().unwrap_or("").to_string())
                            .or_default()
                            .push(lease);
                    }
                    Err(error) => {
                        let mut view = view.lock().unwrap();
                        let conversation = view.history.current_mut();
                        if let Some(conversation) = conversation {
                            conversation.messages.push(Message {
                                id: uuid_like(),
                                role: "notice".into(),
                                text: format!("Automatic edit blocked: {}", error.message),
                            });
                        }
                        drop(view);
                        wake();
                        return json!({ "outcome": { "outcome": "cancelled" } });
                    }
                }
            }
            return json!({ "outcome": { "outcome": "selected", "optionId": allow["optionId"] } });
        }
    }
    let options: Vec<(String, String)> = params["options"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|option| option["kind"] == "allow_once" || option["kind"] == "reject_once")
                .filter_map(|option| {
                    Some((option["optionId"].as_str()?.to_string(), option["name"].as_str().unwrap_or("Allow").to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    if options.is_empty() {
        return json!({ "outcome": { "outcome": "cancelled" } });
    }
    let approval = Approval {
        id: uuid_like(),
        title: tool_call["title"].as_str().unwrap_or("External or unclassified operation").to_string(),
        detail: tool_call
            .get("rawInput")
            .map(|raw| serde_json::to_string_pretty(raw).unwrap_or_default())
            .unwrap_or_default(),
        options,
    };
    let (sender, receiver) = mpsc::channel();
    pending.lock().unwrap().insert(approval.id.clone(), sender);
    {
        let mut view = view.lock().unwrap();
        view.approvals.push(approval.clone());
        view.activity = Activity::Approval;
    }
    wake();
    match receiver.recv_timeout(Duration::from_secs(600)) {
        Ok(Some(option_id)) => json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
        _ => {
            pending.lock().unwrap().remove(&approval.id);
            let mut view = view.lock().unwrap();
            view.approvals.retain(|item| item.id != approval.id);
            drop(view);
            wake();
            json!({ "outcome": { "outcome": "cancelled" } })
        }
    }
}

fn cli_command() -> String {
    if let Ok(configured) = std::env::var("COPILOT_CLI_PATH") {
        return configured;
    }
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
            let packaged = Path::new(&appdata)
                .join("npm")
                .join("node_modules")
                .join("@github")
                .join("copilot")
                .join("node_modules")
                .join("@github")
                .join(format!("copilot-win32-{arch}"))
                .join("copilot.exe");
            if packaged.exists() {
                return packaged.to_string_lossy().into_owned();
            }
        }
    }
    "copilot".to_string()
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{nanos:x}-{:x}", std::process::id())
}

fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", now.as_secs(), now.subsec_millis())
}
