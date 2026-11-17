# Search Here

Fast search for VS Code: text, files, folders and symbols in a single view, with a live code preview, include/exclude filters and saved scopes.

## Opening it

The search comes in three forms that share the same engine and filters:

| Command | Shortcut | Opens |
|---|---|---|
| **Search Here: Open Search** | `Ctrl+Alt+F` | Whatever `searchHere.defaultOpen` says: panel, editor tab or dialog |
| **Search Here: Open Search in Panel** | | The full view in the bottom panel, next to the Terminal |
| **Search Here: Open Search in Editor Tab** | | The full view in an editor tab (reusing the open one or not, see `searchHere.editorTab`) |
| **Search Here: Open Search in New Editor Tab** | | Always a new editor tab, so you can keep several searches open |
| **Search Here: Quick Search** | `Ctrl+Alt+P` | A Ctrl+P-style dialog that previews results in the editor as you move through them; press `Ctrl+Alt+P` again to switch mode |

The **Search** button in the status bar does the same as `Ctrl+Alt+F` (hide it with `searchHere.showStatusBarItem`).

Moving between them keeps the query, mode, scope and filters:

- the **Move to Editor Tab** button in the panel's title bar turns the panel search into an editor tab and hides the panel
- the **Move to Panel** button in the editor tab's title bar does the opposite
- the dialog has **Open in the Panel** and **Open in an Editor Tab** buttons

Editor tabs are titled after their query (`Search: useSocket`).

If text is selected in the editor, it becomes the query.

## Modes

- **All**: folders, files, symbols and text together, in sections
- **Text**: file contents (ripgrep)
- **Files** / **Folders**: names, with fuzzy matching (`usock` finds `useSocket.ts`; every space-separated term must match)
- **Symbols**: classes, functions, variables… from the installed language servers

`Alt+1…5` switches mode. `Alt+C` match case, `Alt+W` whole word, `Alt+R` regex (lookaround and backreferences are supported through PCRE2).

## Preview

Use `↑` `↓` to move through the results: the right side shows the file colored exactly as in the editor (same grammars, same color theme, your `editor.tokenColorCustomizations` too), the result line highlighted and every match marked. Folders show their content, which you can browse by clicking.

`Enter` opens, `Ctrl+Enter` opens to the side, double-clicking a line in the preview opens the file at that line.

## Scopes (the tabs)

- **Project**: the whole workspace
- **Open Files**: only the files open in editor tabs
- **Git Changes**: modified, staged or untracked files
- **Active Folder**: the folder of the file you were working on
- **Saved scopes**: *Save Scope* turns the current scope and filters into a new tab, saved for this workspace or for all workspaces. Scopes can also be defined in `.vscode/settings.json` to share them with your team:

```json
"searchHere.scopes": [
  { "name": "Backend", "paths": ["server"], "exclude": ["**/*.test.ts"] }
]
```

## Projects

In a multi-root workspace, a monorepo or a folder of repositories, the **project selector** before the scope tabs restricts every scope to one project: *Git Changes* of the backend only, *Open Files* of one package, and so on. It offers:

- **All projects**: the whole workspace
- **Current project**: the project of the file you are working on, which follows you as you switch files
- the **workspace folders** of a multi-root workspace
- the **projects found inside them** by their marker files: `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, `build.gradle`, `*.csproj`, `.git` (repositories, submodules, worktrees)… Folders ignored by `.gitignore` and `node_modules` are skipped

The selector shows up only when there is a project to pick. **Search Here: Select Project** opens it from the Command Palette, and the quick search dialog has a button for it too.

With a project picked, the folders of a scope are relative to it (a `src` scope searches the `src` of that project), while the *Include* / *Exclude* patterns stay relative to the workspace folder, as in the Explorer.

Scopes can be tied to projects:

- **Bound to a project**: the scope always searches in that project, and its tab is hidden while another project is picked. *Save Scope* offers this when you are searching in a project; *Edit* changes it
- **Only in some projects**: the tab shows up only where a project has one of the given files, handy for scopes saved for all workspaces

```json
"searchHere.scopes": [
  { "name": "API tests", "project": "packages/api", "paths": ["test"] },
  { "name": "Rust sources", "include": ["*.rs"], "requires": ["Cargo.toml"] }
]
```

`project` is a workspace folder name or a path relative to it (`backend/packages/api` in a multi-root workspace).

## Filters

In the *Include* / *Exclude* fields, comma separated:

| Pattern | Meaning |
|---|---|
| `src` | any file or folder named `src`, anywhere |
| `./src` or `src/app` | a path from the project root |
| `dist/` | folders only |
| `**/*.test.ts`, `*.{js,ts}` | globs |

Toggles:

- **.gitignore**: respect `.gitignore`, `.ignore` and `.rgignore`. Turn it off to search `node_modules`, `dist`… too
- **VS Code Excludes**: apply `files.exclude` and `search.exclude`
- **Hidden**: include files and folders starting with a dot

`searchHere.exclude` holds permanent exclusions that always apply.

## Explorer

Right-click files or folders (multi-selection works too) → **Search Here**:

- **Search Here**: restrict the search to those items
- **Include in Search** / **Exclude from Search**: add them to the view's filters (kept per project)
- **Always Exclude (Workspace Settings)**: add them to `searchHere.exclude` in the workspace settings

## How it works

- Text is searched with the **ripgrep binary bundled with VS Code**, so it works on Windows, macOS and Linux with nothing to install (`searchHere.ripgrepPath` lets you use another one).
- File and folder names come from an in-memory `rg --files` listing that is refreshed when files are created or deleted, so fuzzy matching runs in memory on every keystroke.
- Symbols come from the language servers through `vscode.executeWorkspaceSymbolProvider`.
- Text search reads files from disk, so unsaved changes are not found (the preview does show them).

## Settings

| Setting | Default | Description |
|---|---|---|
| `searchHere.defaultOpen` | `panel` | What `Ctrl+Alt+F` and the status bar button open: `panel`, `editor` (editor tab) or `dialog` (quick search) |
| `searchHere.editorTab` | `reuse` | `reuse` focuses the search tab already open, `new` opens a new tab every time |
| `searchHere.showStatusBarItem` | `true` | Show the Search button in the status bar |
| `searchHere.exclude` | `[]` | Globs that are always excluded |
| `searchHere.useVSCodeExcludes` | `true` | Initial state of the *VS Code Excludes* toggle |
| `searchHere.respectGitignore` | `true` | Initial state of the *.gitignore* toggle |
| `searchHere.maxResults` | `5000` | Maximum matching lines for a text search |
| `searchHere.maxFileSize` | `10M` | Largest file to search |
| `searchHere.followSymlinks` | `false` | Follow symbolic links |
| `searchHere.ripgrepPath` | | Custom ripgrep executable |
| `searchHere.scopes` | `[]` | Shareable scopes shown as tabs |
| `searchHere.projects.workspaceFolders` | `true` | Offer the workspace folders of a multi-root workspace as projects |
| `searchHere.projects.detect` | `true` | Find the projects inside the workspace folders by their marker files |
| `searchHere.projects.markers` | `package.json`, `go.mod`, `.git`… | Files that make their folder a project |
| `searchHere.projects.followActiveFile` | `true` | Offer *Current project*, which follows the active file |

## Development

```bash
npm install
npm run build      # or: npm run watch
```

Press `F5` in VS Code to launch a window with the extension loaded. `npm run package` builds the `.vsix`, which you can install from *Extensions → … → Install from VSIX*.
