---
name: desktop-automation
description: Drive any Windows application the user names (a form, a design tool, an installer, a dialog you have never seen) with the desk tool — read the UI tree first, fill and press by reference, fall back to screenshots and the vision model only when the app exposes no tree, and prove every step by reading the window back.
---
<!-- Original AbdoCode skill (TechnologyKSA, 2026-09-14). -->

# Desktop automation on interfaces you were not trained on

You do not know this application. Do not guess coordinates from memory. Ask the operating system what is on screen, act by reference, and read the window back after every step. The order below is the tool ladder: deterministic first, vision last.

## 0. Preconditions

- `desk` needs **Desktop control** enabled (Settings → Runtime & safety). If a `desk` call is refused as switched off, stop and ask the user to enable it. No other tool reaches the desktop.
- Every input action goes through the approval gate. Say in one line what you are about to do in the window before you do it.
- Coordinates are **physical pixels from the top-left corner of the bound window**, exactly as the screenshot and the `ui` tree report them. Never use screen coordinates.

## 1. Start the application and bind its window

```
نفّذ: desk open notepad          (a program name, an .exe path, or a document path — never `run notepad`)
```

`desk open` launches through the Windows shell, waits for the new window, binds it, and **names every other window that appeared with it**. A line such as `⚠ ظهرت معها نافذةٌ أخرى: «Pick an app»` means Windows is asking which program should open the file: `desk focus pid:<that pid>`, `desk ui`, `desk press` the entry you want (e.g. «Notepad»), then `desk focus` your target again. Do not start desktop programs with `run`/`exec`: inside the engine's shell `notepad` is a Git wrapper script that opens a file and triggers that picker.

If the window is already open (Windows 11 Notepad opens a new tab in its existing window), `desk open` binds the existing window and says so.

To bind a window that is already on screen:

```
نفّذ: desk windows
نفّذ: desk focus <part of the title>     (or: desk focus pid:<number> when titles are localized or duplicated)
```

`desk windows` marks windows that appeared since the last listing as «جديدة»: a picker, a save dialog, a permission prompt. Handle them before continuing. Window titles follow the user's Windows language (Arabic Windows may show «المفكرة», not "Notepad"); pick from the list, never guess. A failed `desk focus` already lists the visible windows with their pids — use one of them instead of trying another spelling.

## 2. Read the interface tree before anything else

```
نفّذ: desk ui
```

You get every control the application announces: `u7 [Edit] «Email» = "" @(120,88 300×28) {Value}`. Use it to:

- **Fill a field**: `نفّذ: desk set u7 user@example.com` — the tool replaces the field's text (never appends) and reads it back; a mismatch is reported as a failure, not hidden.
- **Press a button / toggle a checkbox / pick a list item**: `نفّذ: desk press u3` — uses the control's own pattern (Invoke, Toggle, Select, Expand) and only clicks its centre when no pattern exists.
- Then `desk ui` again to see the effect (a new dialog, a validation message, a changed value). The tree is the truth, not your expectation.

Refs are stable only for the tree you last read. After anything changed on screen, read again; a stale ref is refused.

## 3. Popups, prompts and overlays

A dialog that appeared on top ("Looking for results in English?", "Save changes?", a cookie or licence prompt) is just another window or a child of yours:

1. `desk ui` — the dialog's buttons are in the tree. Prefer the closing choice that keeps the user's state: «Keep», «No thanks», «Cancel», «Close», «×». Never press «Accept all», «Continue», «Delete» or anything that pays, sends or destroys without an explicit instruction.
2. `desk press uN` on that button, then `desk ui` to confirm it is gone.
3. If the dialog is a separate top-level window, `desk windows` shows it; `desk focus` it, close it, then re-focus your target.

In the browser the same loop is `page` → `dismiss` → `page`.

## 4. When the tree is empty (canvas apps, games, remote desktops, some Electron/Qt views)

Only now use vision:

1. `نفّذ: desk shot` — the bound window is photographed at true pixel size and attached to your next call.
2. Name the element you need and its pixel coordinates **from that image** (the image's top-left is the window's top-left).
3. `نفّذ: desk click <x> <y>` then `desk shot` again and compare: did the state change? If not, do not repeat the same click; read the new image, reconsider, or ask.
4. Type with `desk type <text>` only after a click that visibly focused a text field; use `desk key Tab` to move between fields, `desk key Enter` to submit.

Rules for vision steps: one action per screenshot; never chain three blind clicks; a screenshot that looks identical to the previous one means the action did not land.

## 5. Filling a whole form from data the user gave

1. `desk ui` and list the fields you found against the fields the user's data has. Say which are missing before filling.
2. Fill in the order the form shows, `desk set` each; for combo boxes `desk press` the box, `desk ui`, then `desk press` the item.
3. Do not press Submit / Save / Send unless the user asked for it in this task. Stop before it and show the filled state (`desk ui` or `desk shot`).
4. Passwords: the tool never reads password fields back; do not echo their value in your text either.

## 6. Design tools and heavy applications (Photoshop, Blender, Office)

Prefer the application's own scripting before the mouse: Blender runs Python headless, Photoshop runs ExtendScript/UXP scripts and COM, Office has COM automation. Write the script with `write`, run it with `exec`, and use `desk shot` only to verify the visible result. Use the mouse path of §4 for the steps that have no scripting surface.

## 7. Report

End with what changed, proven by the window: the final `desk ui` lines or the final screenshot, and anything you did not do (a submit you left for the user, a dialog you did not understand).
