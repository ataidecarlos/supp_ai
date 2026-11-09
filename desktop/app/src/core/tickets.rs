use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub main_file: Option<String>,
    pub main_candidates: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
}

pub fn inside(root: &Path, target: &Path) -> bool {
    match target.strip_prefix(root) {
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    }
}

pub fn ticket_id(root: &Path) -> String {
    let canonical = root.to_string_lossy();
    let key = if cfg!(windows) {
        canonical.to_lowercase()
    } else {
        canonical.into_owned()
    };
    let digest = Sha256::digest(key.as_bytes());
    digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

fn natural_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left_chars = left.char_indices().peekable();
    let mut right_chars = right.char_indices().peekable();
    loop {
        match (left_chars.peek(), right_chars.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some((left_at, left_char)), Some((right_at, right_char))) => {
                if left_char.is_ascii_digit() && right_char.is_ascii_digit() {
                    let left_end = left[*left_at..]
                        .find(|character: char| !character.is_ascii_digit())
                        .map(|offset| *left_at + offset)
                        .unwrap_or(left.len());
                    let right_end = right[*right_at..]
                        .find(|character: char| !character.is_ascii_digit())
                        .map(|offset| *right_at + offset)
                        .unwrap_or(right.len());
                    let left_number = left[*left_at..left_end].trim_start_matches('0');
                    let right_number = right[*right_at..right_end].trim_start_matches('0');
                    let ordering = left_number
                        .len()
                        .cmp(&right_number.len())
                        .then_with(|| left_number.cmp(right_number))
                        .then_with(|| left[*left_at..left_end].cmp(&right[*right_at..right_end]));
                    if ordering != std::cmp::Ordering::Equal {
                        return ordering;
                    }
                    while left_chars.peek().is_some_and(|(at, _)| *at < left_end) {
                        left_chars.next();
                    }
                    while right_chars.peek().is_some_and(|(at, _)| *at < right_end) {
                        right_chars.next();
                    }
                } else {
                    if left_char != right_char {
                        return left_char.cmp(right_char);
                    }
                    left_chars.next();
                    right_chars.next();
                }
            }
        }
    }
}

pub fn discover_tickets(root: &Path, data_dir: &Path) -> Result<Vec<Ticket>> {
    let canonical = std::fs::canonicalize(root)
        .map_err(|error| Error::new("ROOT", format!("Cannot open {}: {error}", root.display())))?;
    if !canonical.is_dir() {
        return Err(Error::new("ROOT", "Select a directory containing ticket folders."));
    }
    let entries = std::fs::read_dir(&canonical)
        .map_err(|error| Error::new("ROOT", format!("Cannot list {}: {error}", canonical.display())))?;
    let mut tickets = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| Error::new("ROOT", format!("Cannot read a ticket: {error}")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| Error::new("ROOT", format!("Cannot inspect {name}: {error}")))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let ticket_root = std::fs::canonicalize(entry.path())
            .map_err(|error| Error::new("ROOT", format!("Cannot open {name}: {error}")))?;
        if !inside(&canonical, &ticket_root) {
            continue;
        }
        let children = std::fs::read_dir(&ticket_root).map_err(|error| {
            Error::new("ROOT", format!("Cannot list {}: {error}", ticket_root.display()))
        })?;
        let mut markdown: Vec<String> = Vec::new();
        for child in children {
            let child = child.map_err(|error| Error::new("ROOT", format!("Cannot read a file: {error}")))?;
            let file_name = child.file_name().to_string_lossy().into_owned();
            let is_file = child.file_type().map(|kind| kind.is_file()).unwrap_or(false);
            if is_file && file_name.to_lowercase().ends_with(".md") {
                markdown.push(file_name);
            }
        }
        markdown.sort_by(|left, right| natural_cmp(left, right));
        let numeric_id: String = name
            .chars()
            .rev()
            .take_while(|character| character.is_ascii_digit())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let matching: Vec<String> = markdown
            .iter()
            .filter(|file| **file == format!("{name}.md") || (!numeric_id.is_empty() && **file == format!("{numeric_id}.md")))
            .cloned()
            .collect();
        let candidates = if matching.is_empty() { markdown.clone() } else { matching.clone() };
        let mut main_file = if matching.len() == 1 { Some(matching[0].clone()) } else { None };
        let id = ticket_id(&ticket_root);
        let saved_path = data_dir.join("tickets").join(&id).join("ticket.json");
        if let Ok(saved) = std::fs::read_to_string(&saved_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&saved) {
                if let Some(selected) = value.get("mainFile").and_then(|value| value.as_str()) {
                    if markdown.iter().any(|file| file == selected) {
                        main_file = Some(selected.to_string());
                    }
                }
            }
        }
        tickets.push(Ticket { id, name, root: ticket_root, main_file, main_candidates: candidates });
    }
    tickets.sort_by(|left, right| natural_cmp(&left.name, &right.name));
    Ok(tickets)
}

pub fn resolve(ticket: &Ticket, relative: &str, allow_new: bool) -> Result<PathBuf> {
    if relative.is_empty() || relative.contains('\0') || relative.contains(':') || Path::new(relative).is_absolute() {
        return Err(Error::new("PATH", "Use a ticket-relative file path."));
    }
    let target = ticket.root.join(relative);
    if !inside(&ticket.root, &target) || target == ticket.root {
        return Err(Error::new("PATH", "The file is outside this ticket."));
    }
    let canonical = match std::fs::canonicalize(&target) {
        Ok(canonical) => canonical,
        Err(error) if allow_new && error.kind() == std::io::ErrorKind::NotFound => {
            let mut ancestor = target.parent().unwrap_or(&ticket.root).to_path_buf();
            loop {
                match std::fs::canonicalize(&ancestor) {
                    Ok(existing) => {
                        return Ok(existing.join(target.strip_prefix(&ancestor).unwrap_or(Path::new(""))));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let Some(parent) = ancestor.parent() else {
                            return Err(Error::new("PATH", "The file parent does not exist."));
                        };
                        ancestor = parent.to_path_buf();
                    }
                    Err(error) => {
                        return Err(Error::new("PATH", format!("Cannot resolve the file: {error}")));
                    }
                }
            }
        }
        Err(error) => return Err(Error::new("PATH", format!("Cannot resolve the file: {error}"))),
    };
    if !inside(&ticket.root, &canonical) {
        return Err(Error::new("PATH", "A link or junction points outside this ticket."));
    }
    Ok(canonical)
}

pub fn list_files(ticket: &Ticket) -> Result<Vec<FileEntry>> {
    let mut files = Vec::new();
    visit(ticket, &ticket.root, &mut files)?;
    files.sort_by(|left, right| natural_cmp(&left.path, &right.path));
    Ok(files)
}

fn visit(ticket: &Ticket, directory: &Path, files: &mut Vec<FileEntry>) -> Result<()> {
    let entries = std::fs::read_dir(directory)
        .map_err(|error| Error::new("IO", format!("Cannot list {}: {error}", directory.display())))?;
    for entry in entries {
        let entry = entry.map_err(|error| Error::new("IO", format!("Cannot read a file: {error}")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| Error::new("IO", format!("Cannot inspect {name}: {error}")))?;
        if file_type.is_symlink() {
            continue;
        }
        let absolute = directory.join(entry.file_name());
        if !inside(&ticket.root, &absolute) {
            continue;
        }
        if file_type.is_dir() {
            visit(ticket, &absolute, files)?;
        } else if file_type.is_file() {
            if files.len() >= 5000 {
                return Err(Error::new("LIMIT", "This ticket exceeds the 5,000-file viewer limit."));
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            files.push(FileEntry {
                path: absolute
                    .strip_prefix(&ticket.root)
                    .unwrap_or(&absolute)
                    .to_string_lossy()
                    .into_owned(),
                size,
            });
        }
    }
    Ok(())
}
