# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The code preview uses the syntax colors of your color theme, including `editor.tokenColorCustomizations`, and follows theme changes. Control flow keywords (`if`, `return`, `import`…) are told apart from the other keywords, as most themes do.

## [0.1.0] - 2026-10-20

First release.

### Added

- **Search view** with five modes: **All** (folders, files, symbols and text in sections), **Text**, **Files**, **Folders** and **Symbols**. Text is searched with the ripgrep binary bundled with VS Code, so nothing has to be installed on Windows, macOS or Linux; file and folder names are matched fuzzily in memory; symbols come from the language servers.
- **Code preview** next to the results: the file with syntax highlighting, the result line highlighted and every match marked, following the selection while moving with `↑` `↓`. Folders show their content, which can be browsed.
- **Filters**: *Include* and *Exclude* fields (`name` anywhere, `./path` from the root, `folder/` folders only, any glob), toggles for `.gitignore`, VS Code's `files.exclude` / `search.exclude` and hidden files, match case, whole word and regular expressions (with lookaround through PCRE2), and the `searchHere.exclude` setting for permanent exclusions.
- **Scopes** as tabs: **Project**, **Open Files**, **Git Changes**, **Active Folder**, and scopes saved from the current filters for this project, for all projects, or shared in `searchHere.scopes`.
- **Explorer** context menu: **Search Here**, **Include in Search**, **Exclude from Search** and **Always Exclude (Workspace Settings)**, also on multiple selected items.
- Three ways to open it: the **bottom panel**, an **editor tab** (one or several, titled after their query) and a **quick search dialog** (`Ctrl+Alt+P`) that previews results in the editor. `searchHere.defaultOpen` chooses what `Ctrl+Alt+F` and the **Search** button in the status bar open, `searchHere.editorTab` whether an editor tab is reused or a new one is opened, and **Move to Editor Tab** / **Move to Panel** move a search between the two, keeping its query and filters.
