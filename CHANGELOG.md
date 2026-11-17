# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Projects**: a project selector before the scope tabs restricts every scope to one project of a multi-root workspace, a monorepo or a folder of repositories. It lists the workspace folders, the projects found inside them by their marker files (`package.json`, `go.mod`, `Cargo.toml`, `*.csproj`, `.git`… configurable in `searchHere.projects.markers`) and **Current project**, which follows the active file. Also available as **Search Here: Select Project** and from a button in the quick search dialog. Each behavior can be turned off in the `searchHere.projects.*` settings.
- Scopes can be **bound to a project** (`"project"` in `searchHere.scopes`, or from *Save Scope* and *Edit*): they always search in it, with their folders relative to it, and are hidden while another project is picked.
- Scopes can be shown **only in projects that have some files** (`"requires": ["Cargo.toml"]`), for scopes saved for all workspaces.

### Changed

- Saved scopes are saved for "this workspace" or "all workspaces" (they were called "this project" and "all projects").
- **Search Here** from the Explorer and from a result goes back to all projects, since it names the folder to search.

## [0.2.0] - 2026-10-22

### Changed

- The code preview is colored exactly as the editor colors the file: it is tokenized with the TextMate grammars of VS Code and of your extensions, and styled with your color theme and `editor.tokenColorCustomizations`, following theme changes. Variables, properties, function calls and every other token the theme colors look as in the editor, for every language that has a grammar installed, and the language is found as VS Code finds it (including `files.associations`). The preview also uses the editor background.
- From a search in an editor tab, `Enter` and double click now open the result as a new tab in the same editor group, instead of in another group. `Ctrl`+`Enter` still opens it to the side.

### Fixed

- The **Search** button in the status bar is shown as soon as VS Code starts, not only after the search view or a command was opened.

## [0.1.0] - 2026-10-20

First release.

### Added

- **Search view** with five modes: **All** (folders, files, symbols and text in sections), **Text**, **Files**, **Folders** and **Symbols**. Text is searched with the ripgrep binary bundled with VS Code, so nothing has to be installed on Windows, macOS or Linux; file and folder names are matched fuzzily in memory; symbols come from the language servers.
- **Code preview** next to the results: the file with syntax highlighting, the result line highlighted and every match marked, following the selection while moving with `↑` `↓`. Folders show their content, which can be browsed.
- **Filters**: *Include* and *Exclude* fields (`name` anywhere, `./path` from the root, `folder/` folders only, any glob), toggles for `.gitignore`, VS Code's `files.exclude` / `search.exclude` and hidden files, match case, whole word and regular expressions (with lookaround through PCRE2), and the `searchHere.exclude` setting for permanent exclusions.
- **Scopes** as tabs: **Project**, **Open Files**, **Git Changes**, **Active Folder**, and scopes saved from the current filters for this project, for all projects, or shared in `searchHere.scopes`.
- **Explorer** context menu: **Search Here**, **Include in Search**, **Exclude from Search** and **Always Exclude (Workspace Settings)**, also on multiple selected items.
- Three ways to open it: the **bottom panel**, an **editor tab** (one or several, titled after their query) and a **quick search dialog** (`Ctrl+Alt+P`) that previews results in the editor. `searchHere.defaultOpen` chooses what `Ctrl+Alt+F` and the **Search** button in the status bar open, `searchHere.editorTab` whether an editor tab is reused or a new one is opened, and **Move to Editor Tab** / **Move to Panel** move a search between the two, keeping its query and filters.
