use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::error::{Error, Result, atomic_write};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    #[serde(default)]
    pub conversations: Vec<Conversation>,
    #[serde(default)]
    pub current_id: Option<String>,
}

impl History {
    pub fn current(&self) -> Option<&Conversation> {
        self.current_id
            .as_ref()
            .and_then(|id| self.conversations.iter().find(|conversation| &conversation.id == id))
    }

    pub fn current_mut(&mut self) -> Option<&mut Conversation> {
        let id = self.current_id.clone()?;
        self.conversations.iter_mut().find(|conversation| conversation.id == id)
    }
}

pub fn load_history(path: &Path) -> Result<History> {
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(History::default()),
        Err(error) => {
            return Err(Error::new("STATE", format!("Cannot read {}: {error}", path.display())));
        }
    };
    let value: Value = serde_json::from_str(&source)
        .map_err(|error| Error::new("STATE", format!("Cannot parse {}: {error}", path.display())))?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::new("STATE", format!("Saved conversation state in {} is invalid.", path.display())))?;
    let invalid = || Error::new("STATE", format!("Saved conversation state in {} is invalid.", path.display()));
    let conversations = match object.get("conversations") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                let conversation: Conversation =
                    serde_json::from_value(item.clone()).map_err(|_| invalid())?;
                if !["user", "agent", "notice"].contains(&conversation.messages.iter().map(|message| message.role.as_str()).next().unwrap_or("user")) {
                    return Err(invalid());
                }
                if conversation.messages.iter().any(|message| !["user", "agent", "notice"].contains(&message.role.as_str())) {
                    return Err(invalid());
                }
                Ok(conversation)
            })
            .collect::<Result<Vec<_>>>()?,
        Some(_) => return Err(invalid()),
    };
    let current_id = match object.get("currentId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => {
            if !conversations.iter().any(|conversation| &conversation.id == id) {
                return Err(invalid());
            }
            Some(id.clone())
        }
        Some(_) => return Err(invalid()),
    };
    Ok(History { conversations, current_id })
}

pub fn save_history(path: &Path, history: &History) -> Result<()> {
    let mut object = match std::fs::read_to_string(path) {
        Ok(source) => serde_json::from_str::<Value>(&source)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_else(Map::new),
        Err(_) => Map::new(),
    };
    object.insert(
        "conversations".to_string(),
        serde_json::to_value(&history.conversations)
            .map_err(|error| Error::new("STATE", format!("Cannot serialize conversations: {error}")))?,
    );
    object.insert(
        "currentId".to_string(),
        serde_json::to_value(&history.current_id)
            .map_err(|error| Error::new("STATE", format!("Cannot serialize conversations: {error}")))?,
    );
    let bytes = serde_json::to_vec(&Value::Object(object))
        .map_err(|error| Error::new("STATE", format!("Cannot serialize conversations: {error}")))?;
    atomic_write(path, &bytes)
}
