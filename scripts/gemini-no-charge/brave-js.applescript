on run argv
  if (count of argv) < 1 then
    return "ERROR: missing js"
  end if
  set jsCode to item 1 of argv
  tell application "Brave Browser"
    if not running then return "ERROR: Brave not running"
    activate
    set theTab to active tab of front window
    return execute theTab javascript jsCode
  end tell
end run
