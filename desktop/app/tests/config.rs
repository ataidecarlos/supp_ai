mod support;

use suppai::core::config::{ConfigPatch, PaneWidths, Side, read_config, write_config};
use suppai::core::settings::{Settings, read_settings};

#[test]
fn defaults_when_the_file_is_absent() {
    let dir = support::tempdir();
    let config = read_config(&dir).unwrap();
    assert_eq!(config.chat_side, Side::Left);
    assert_eq!(config.files_side, Side::Right);
    assert!(!config.files_hidden);
    assert!(config.pane_widths.is_none());
}

#[test]
fn malformed_config_is_reported_and_not_overwritten() {
    let dir = support::tempdir();
    std::fs::write(dir.join("config.json"), "{ nope").unwrap();
    assert!(read_config(&dir).is_err());
    assert!(write_config(&dir, &ConfigPatch { files_hidden: Some(true), pane_widths: None }).is_err());
    assert_eq!(std::fs::read_to_string(dir.join("config.json")).unwrap(), "{ nope");
}

#[test]
fn invalid_values_name_the_path() {
    let dir = support::tempdir();
    std::fs::write(dir.join("config.json"), r#"{"chatSide":"middle"}"#).unwrap();
    let error = read_config(&dir).unwrap_err();
    assert!(error.message.contains("config.json"), "{}", error.message);
}

#[test]
fn unknown_keys_survive_a_write() {
    let dir = support::tempdir();
    std::fs::write(dir.join("config.json"), r#"{"future":true,"chatSide":"right"}"#).unwrap();
    let config = write_config(&dir, &ConfigPatch { files_hidden: Some(true), pane_widths: None }).unwrap();
    assert!(config.files_hidden);
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(raw["future"], true);
    assert_eq!(raw["chatSide"], "right");
}

#[test]
fn pane_widths_round_trip_and_validate() {
    let dir = support::tempdir();
    let config = write_config(
        &dir,
        &ConfigPatch {
            files_hidden: None,
            pane_widths: Some(PaneWidths { session: 420.0, tree: 300.0 }),
        },
    )
    .unwrap();
    assert_eq!(config.pane_widths, Some(PaneWidths { session: 420.0, tree: 300.0 }));
    std::fs::write(dir.join("config.json"), r#"{"paneWidths":{"session":1,"tree":300}}"#).unwrap();
    assert!(read_config(&dir).is_err());
}

#[test]
fn settings_accept_a_null_root() {
    let dir = support::tempdir();
    let path = dir.join("settings.json");
    std::fs::write(&path, r#"{"root":null,"lastTicketId":null}"#).unwrap();
    let settings = read_settings(&path).unwrap();
    assert!(settings.root.is_none() && settings.last_ticket_id.is_none());
}

#[test]
fn settings_reject_wrong_types_and_missing_root() {
    let dir = support::tempdir();
    let path = dir.join("settings.json");
    std::fs::write(&path, r#"{"root":5}"#).unwrap();
    assert!(read_settings(&path).is_err());
    std::fs::write(&path, r#"{"lastTicketId":null}"#).unwrap();
    assert!(read_settings(&path).is_err());
}

#[test]
fn settings_round_trip() {
    let dir = support::tempdir();
    let path = dir.join("settings.json");
    let settings = Settings {
        root: Some("C:\\tickets".into()),
        last_ticket_id: Some("abc".into()),
    };
    suppai::core::settings::write_settings(&path, &settings).unwrap();
    assert_eq!(read_settings(&path).unwrap(), settings);
}
