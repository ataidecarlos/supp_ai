use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::error::{Error, Result, atomic_write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PaneWidths {
    pub session: f32,
    pub tree: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub chat_side: Side,
    pub files_side: Side,
    pub files_hidden: bool,
    pub pane_widths: Option<PaneWidths>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            chat_side: Side::Left,
            files_side: Side::Right,
            files_hidden: false,
            pane_widths: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConfigPatch {
    pub files_hidden: Option<bool>,
    pub pane_widths: Option<PaneWidths>,
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

pub fn read_config(dir: &Path) -> Result<Config> {
    let path = config_path(dir);
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(error) => {
            return Err(Error::new("STATE", format!("Cannot read {}: {error}", path.display())));
        }
    };
    let value: Value = serde_json::from_str(&source)
        .map_err(|error| Error::new("STATE", format!("Cannot parse {}: {error}", path.display())))?;
    parse_config(&value, &path)
}

fn parse_config(value: &Value, path: &Path) -> Result<Config> {
    let object = value.as_object().ok_or_else(|| {
        Error::new("STATE", format!("Configuration at {} must be a JSON object.", path.display()))
    })?;
    let side = |key: &str, default: Side| -> Result<Side> {
        match object.get(key) {
            None => Ok(default),
            Some(Value::String(text)) if text == "left" => Ok(Side::Left),
            Some(Value::String(text)) if text == "right" => Ok(Side::Right),
            Some(_) => Err(Error::new(
                "STATE",
                format!("Set \"{key}\" to \"left\" or \"right\" in {}", path.display()),
            )),
        }
    };
    let files_hidden = match object.get("filesHidden") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err(Error::new(
                "STATE",
                format!("Set \"filesHidden\" to true or false in {}", path.display()),
            ));
        }
    };
    let pane_widths = match object.get("paneWidths") {
        None | Some(Value::Null) => None,
        Some(Value::Object(widths)) => {
            let read = |key: &str| {
                widths
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|value| (120.0..=1200.0).contains(value))
            };
            match (read("session"), read("tree")) {
                (Some(session), Some(tree)) => Some(PaneWidths {
                    session: session as f32,
                    tree: tree as f32,
                }),
                _ => {
                    return Err(Error::new(
                        "STATE",
                        format!(
                            "\"paneWidths\" needs session and tree between 120 and 1200 in {}",
                            path.display()
                        ),
                    ));
                }
            }
        }
        Some(_) => {
            return Err(Error::new(
                "STATE",
                format!("\"paneWidths\" must be an object in {}", path.display()),
            ));
        }
    };
    Ok(Config {
        chat_side: side("chatSide", Side::Left)?,
        files_side: side("filesSide", Side::Right)?,
        files_hidden,
        pane_widths,
    })
}

pub fn write_config(dir: &Path, patch: &ConfigPatch) -> Result<Config> {
    let path = config_path(dir);
    let mut object = match std::fs::read_to_string(&path) {
        Ok(source) => serde_json::from_str::<Value>(&source)
            .map_err(|error| Error::new("STATE", format!("Cannot parse {}: {error}", path.display())))?
            .as_object()
            .cloned()
            .ok_or_else(|| {
                Error::new("STATE", format!("Configuration at {} must be a JSON object.", path.display()))
            })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(error) => {
            return Err(Error::new("STATE", format!("Cannot read {}: {error}", path.display())));
        }
    };
    if let Some(hidden) = patch.files_hidden {
        object.insert("filesHidden".to_string(), Value::Bool(hidden));
    }
    if let Some(widths) = patch.pane_widths {
        object.insert(
            "paneWidths".to_string(),
            json!({ "session": widths.session, "tree": widths.tree }),
        );
    }
    let config = parse_config(&Value::Object(object.clone()), &path)?;
    let bytes = serde_json::to_vec_pretty(&Value::Object(object))
        .map_err(|error| Error::new("STATE", format!("Cannot serialize config: {error}")))?;
    atomic_write(&path, &bytes)?;
    Ok(config)
}
