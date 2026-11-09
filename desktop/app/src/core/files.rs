use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::error::{Error, Result, atomic_write};
use super::tickets::{Ticket, list_files, resolve};

const TEXT_EXTENSIONS: &[&str] = &[
    ".md", ".markdown", ".txt", ".log", ".json", ".jsonl", ".csv", ".yaml", ".yml", ".xml", ".ini",
    ".conf", ".sql", ".ts", ".js", ".py", "",
];
const IMAGE_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Markdown,
    Text,
    Image,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub content: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDocument {
    pub path: String,
    pub kind: FileKind,
    pub content: String,
    pub revision: String,
    pub size: u64,
    pub recovered_draft: Option<Draft>,
}

pub fn revision_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn key(relative: &str) -> String {
    revision_of(relative.as_bytes())[..32].to_string()
}

struct Lease_ {
    paths: Vec<PathBuf>,
    store: Store,
}

impl Drop for Lease_ {
    fn drop(&mut self) {
        let mut writes = self.store.agent_writes.lock().unwrap();
        for path in &self.paths {
            writes.remove(path);
        }
    }
}

pub struct Lease {
    _inner: Lease_,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Lease")
    }
}

#[derive(Clone)]
pub struct Store {
    data_dir: PathBuf,
    agent_writes: Arc<Mutex<HashSet<PathBuf>>>,
    gates: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>,
}

impl Store {
    pub fn new(data_dir: PathBuf) -> Self {
        Store {
            data_dir,
            agent_writes: Arc::new(Mutex::new(HashSet::new())),
            gates: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn draft_path(&self, ticket: &Ticket, relative: &str) -> PathBuf {
        self.data_dir.join("tickets").join(&ticket.id).join("drafts").join(format!("{}.json", key(relative)))
    }

    pub fn recovery_path(&self, ticket: &Ticket, relative: &str) -> PathBuf {
        self.data_dir.join("tickets").join(&ticket.id).join("recovery").join(format!("{}.json", key(relative)))
    }

    fn gate(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut gates = self.gates.lock().unwrap();
        gates.entry(path.to_path_buf()).or_default().clone()
    }

    pub fn read(&self, ticket: &Ticket, relative: &str) -> Result<FileDocument> {
        let target = resolve(ticket, relative, false)?;
        let info = std::fs::metadata(&target)
            .map_err(|error| Error::new("FILE", format!("Cannot open {relative}: {error}")))?;
        if !info.is_file() {
            return Err(Error::new("FILE", "The selected path is not a regular file."));
        }
        let extension = target
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let is_image = IMAGE_EXTENSIONS.contains(&extension.as_str());
        let mut document = FileDocument {
            path: relative.to_string(),
            kind: FileKind::Unsupported,
            content: String::new(),
            revision: String::new(),
            size: info.len(),
            recovered_draft: None,
        };
        let limit = if is_image { 10 } else { 2 } * 1024 * 1024;
        if info.len() > limit {
            return Ok(document);
        }
        let bytes = std::fs::read(&target)
            .map_err(|error| Error::new("FILE", format!("Cannot read {relative}: {error}")))?;
        document.revision = revision_of(&bytes);
        if is_image {
            document.kind = FileKind::Image;
        } else if TEXT_EXTENSIONS.contains(&extension.as_str()) {
            document.kind = if extension == ".md" || extension == ".markdown" {
                FileKind::Markdown
            } else {
                FileKind::Text
            };
            document.content = String::from_utf8_lossy(&bytes).into_owned();
            if document.kind == FileKind::Markdown {
                document.recovered_draft = self.read_draft(ticket, relative)?;
            }
        }
        Ok(document)
    }

    fn read_draft(&self, ticket: &Ticket, relative: &str) -> Result<Option<Draft>> {
        let path = self.draft_path(ticket, relative);
        let source = match std::fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(Error::new("STATE", format!("Cannot read a draft: {error}")));
            }
        };
        let value: serde_json::Value = serde_json::from_str(&source)
            .map_err(|error| Error::new("STATE", format!("The recovered editor draft is invalid: {error}")))?;
        let content = value
            .get("content")
            .and_then(|value| value.as_str())
            .ok_or_else(|| Error::new("STATE", "The recovered editor draft is invalid."))?;
        let expected_revision = value
            .get("expectedRevision")
            .and_then(|value| value.as_str())
            .ok_or_else(|| Error::new("STATE", "The recovered editor draft is invalid."))?;
        Ok(Some(Draft { content: content.to_string(), expected_revision: expected_revision.to_string() }))
    }

    pub fn save(&self, ticket: &Ticket, relative: &str, content: &str, expected_revision: &str) -> Result<FileDocument> {
        if content.len() > 2 * 1024 * 1024 {
            return Err(Error::new("LIMIT", "Markdown editing is limited to 2 MiB."));
        }
        let target = resolve(ticket, relative, false)?;
        let is_markdown = target
            .extension()
            .map(|value| value.to_string_lossy().to_lowercase())
            .is_some_and(|extension| extension == "md" || extension == "markdown");
        if !is_markdown {
            return Err(Error::new("FILE", "Only Markdown files can be edited."));
        }
        let draft = serde_json::json!({
            "path": relative,
            "content": content,
            "expectedRevision": expected_revision,
            "savedAt": timestamp(),
        });
        atomic_write(&self.draft_path(ticket, relative), &serde_json::to_vec(&draft).unwrap())?;
        if self.agent_writes.lock().unwrap().contains(&target) {
            return Err(Error::new("BUSY", "Copilot is modifying this file. Your draft is preserved; saving is paused."));
        }
        let gate = self.gate(&target);
        let _guard = gate.lock().unwrap();
        let previous = std::fs::read(&target)
            .map_err(|error| Error::new("FILE", format!("Cannot read {relative}: {error}")))?;
        if revision_of(&previous) != expected_revision {
            return Err(Error::new("CONFLICT", "The file changed on disk. Choose a version before saving."));
        }
        let recovery = serde_json::json!({
            "path": relative,
            "content": String::from_utf8_lossy(&previous),
            "revision": expected_revision,
        });
        atomic_write(&self.recovery_path(ticket, relative), &serde_json::to_vec(&recovery).unwrap())?;
        atomic_write(&target, content.as_bytes())?;
        let written = std::fs::read(&target)
            .map_err(|error| Error::new("FILE", format!("Cannot verify {relative}: {error}")))?;
        if revision_of(&written) != revision_of(content.as_bytes()) {
            return Err(Error::new("CONFLICT", "The file changed while saving. Your draft is preserved."));
        }
        let _ = std::fs::remove_file(self.draft_path(ticket, relative));
        self.read(ticket, relative)
    }

    pub fn discard_draft(&self, ticket: &Ticket, relative: &str) -> Result<()> {
        resolve(ticket, relative, false)?;
        let path = self.draft_path(ticket, relative);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(Error::new("IO", format!("Cannot discard the draft: {error}"))),
        }
    }

    pub fn begin_agent_edit(
        &self,
        ticket: &Ticket,
        paths: &[PathBuf],
        expected: &HashMap<PathBuf, String>,
    ) -> Result<Lease> {
        let mut targets = Vec::new();
        for path in paths {
            let relative = path
                .strip_prefix(&ticket.root)
                .map_err(|_| Error::new("PATH", "The file is outside this ticket."))?;
            targets.push(resolve(ticket, &relative.to_string_lossy(), true)?);
        }
        targets.sort();
        targets.dedup();
        let mut writes = self.agent_writes.lock().unwrap();
        for target in &targets {
            if writes.contains(target) {
                return Err(Error::new("BUSY", "Another agent operation is modifying this file."));
            }
        }
        for target in &targets {
            if let Some(expected) = expected.get(target) {
                let current = std::fs::read(target)
                    .map_err(|error| Error::new("FILE", format!("Cannot read the edited file: {error}")))?;
                if revision_of(&current) != *expected {
                    return Err(Error::new(
                        "CONFLICT",
                        "The file changed after Copilot read it. Its edit was denied; ask it to reread the file.",
                    ));
                }
            }
        }
        for target in &targets {
            writes.insert(target.clone());
        }
        Ok(Lease { _inner: Lease_ { paths: targets, store: self.clone() } })
    }

    pub fn import(&self, ticket: &Ticket, source: &Path, overwrite: bool) -> Result<String> {
        let name = source
            .file_name()
            .ok_or_else(|| Error::new("IMPORT", "Choose a file to import."))?
            .to_string_lossy()
            .into_owned();
        let target = resolve(ticket, &name, true)?;
        if let (Ok(from), Ok(to)) = (std::fs::canonicalize(source), std::fs::canonicalize(&target)) {
            if from == to {
                return Err(Error::new("IMPORT", "This file is already in the ticket."));
            }
        }
        if self.agent_writes.lock().unwrap().contains(&target) {
            return Err(Error::new("BUSY", "Copilot is editing the destination. Try importing later."));
        }
        let gate = self.gate(&target);
        let _guard = gate.lock().unwrap();
        if target.exists() && !overwrite {
            return Err(Error::new("IMPORT", format!("{name} already exists in this ticket.")));
        }
        std::fs::copy(source, &target)
            .map_err(|error| Error::new("IMPORT", format!("Cannot import {name}: {error}")))?;
        Ok(name)
    }

    pub fn files(&self, ticket: &Ticket) -> Result<Vec<super::tickets::FileEntry>> {
        list_files(ticket)
    }
}

fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", now.as_secs(), now.subsec_millis())
}
