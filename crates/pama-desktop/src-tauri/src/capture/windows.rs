//! Windows UI Automation: read the focused element's text selection without the clipboard.

use uiautomation::patterns::UITextPattern;
use uiautomation::UIAutomation;

/// (selected text, app/window name)
pub fn selected_text() -> Option<(String, Option<String>)> {
    let automation = UIAutomation::new().ok()?;
    let focused = automation.get_focused_element().ok()?;
    let pattern = focused.get_pattern::<UITextPattern>().ok()?;
    let ranges = pattern.get_selection().ok()?;
    let text: String = ranges
        .iter()
        .filter_map(|r| r.get_text(-1).ok())
        .collect::<Vec<_>>()
        .join("\n");
    let name = focused.get_name().ok().filter(|n| !n.is_empty());
    (!text.trim().is_empty()).then_some((text, name))
}
