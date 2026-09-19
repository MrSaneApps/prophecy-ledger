on run argv
  if (count of argv) is 0 then
    return "ERROR: missing url-or-list"
  end if
  set targetURL to item 1 of argv
  tell application "Brave Browser"
    if not running then
      return "ERROR: Brave is not running on Mini"
    end if
    activate
    if (count of windows) is 0 then
      make new window
    end if
    if targetURL is "list" then
      set out to ""
      set wcount to count of windows
      repeat with wi from 1 to wcount
        set tcount to count of tabs of window wi
        repeat with ti from 1 to tcount
          set tURL to URL of tab ti of window wi
          set tTitle to title of tab ti of window wi
          set out to out & "W" & wi & "T" & ti & " " & tURL & " | " & tTitle & linefeed
        end repeat
      end repeat
      return out
    end if
    if targetURL is "front" then
      return "FRONT " & (URL of active tab of front window) & " | " & (title of active tab of front window)
    end if
    set reused to false
    set wcount to count of windows
    -- Prefer an existing AI Studio / Cloud Console tab.
    repeat with wi from 1 to wcount
      set tcount to count of tabs of window wi
      repeat with ti from 1 to tcount
        set tURL to URL of tab ti of window wi
        if (tURL contains "aistudio.google.com") or (tURL contains "console.cloud.google.com") or (tURL contains "ai.google.dev") then
          set active tab index of window wi to ti
          set index of window wi to 1
          set URL of tab ti of window wi to targetURL
          set reused to true
          exit repeat
        end if
      end repeat
      if reused then exit repeat
    end repeat
    -- Else reuse an empty new tab so we do not spam tabs.
    if not reused then
      repeat with wi from 1 to wcount
        set tcount to count of tabs of window wi
        repeat with ti from 1 to tcount
          set tURL to URL of tab ti of window wi
          if (tURL is "chrome://newtab/") or (tURL is "about:blank") then
            set active tab index of window wi to ti
            set index of window wi to 1
            set URL of tab ti of window wi to targetURL
            set reused to true
            exit repeat
          end if
        end repeat
        if reused then exit repeat
      end repeat
    end if
    if not reused then
      tell window 1
        make new tab with properties {URL:targetURL}
      end tell
    end if
    delay 1
    return "FRONT " & (URL of active tab of front window) & " | " & (title of active tab of front window)
  end tell
end run
