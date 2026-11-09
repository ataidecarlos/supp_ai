use std::path::Path;

use serde_json::{Value, json};

use super::error::{Error, Result, atomic_write};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings {
    pub root: Option<String>,
    pub last_ticket_id: Option<String>,
}

pub fn read_settings(path: &Path) -> Result<Settings> {
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(error) => {
            return Err(Error::new("STATE", format!("Cannot read {}: {error}", path.display())));
        }
    };
    let value: Value = serde_json::from_str(&source)
        .map_err(|error| Error::new("STATE", format!("Cannot parse {}: {error}", path.display())))?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::new("STATE", "Saved app settings are invalid."))?;
    let root = match object.get("root") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        _ => {
            return Err(Error::new(
                "STATE",
                "Saved ticket-root settings are invalid.",
            ));
        }
    };
    let last_ticket_id = match object.get("lastTicketId") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            return Err(Error::new(
                "STATE",
                "Saved last-ticket setting is invalid.",
            ));
        }
    };
    Ok(Settings {
        root,
        last_ticket_id,
    })
}

pub fn write_settings(path: &Path, settings: &Settings) -> Result<()> {
    let value = json!({ "root": settings.root, "lastTicketId": settings.last_ticket_id });
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| Error::new("STATE", format!("Cannot serialize settings: {error}")))?;
    atomic_write(path, &bytes)
}
