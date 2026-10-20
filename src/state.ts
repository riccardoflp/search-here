import * as vscode from 'vscode';
import { splitPatterns } from './globs';
import { Options, ScopeDef } from './protocol';

export const BUILTIN_SCOPES: ScopeDef[] = [
  { id: 'project', name: 'Project', kind: 'builtin', icon: 'root-folder', paths: [], include: [], exclude: [] },
  { id: 'open', name: 'Open Files', kind: 'builtin', icon: 'files', paths: [], include: [], exclude: [] },
  { id: 'git', name: 'Git Changes', kind: 'builtin', icon: 'source-control', paths: [], include: [], exclude: [] },
  { id: 'activeFolder', name: 'Active Folder', kind: 'builtin', icon: 'folder-active', paths: [], include: [], exclude: [] },
];

const OPTIONS_KEY = 'searchHere.options';
const SCOPES_KEY = 'searchHere.scopes';

type StoredScope = Omit<ScopeDef, 'kind' | 'icon'>;

/** Persistent state: panel options per workspace, saved scopes per workspace or global. */
export class Store implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<{ options?: boolean; rerun?: boolean; scopes?: boolean }>();
  readonly onDidChange = this.emitter.event;
  private readonly configSub: vscode.Disposable;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('searchHere.scopes')) {
        this.emitter.fire({ scopes: true });
      }
    });
  }

  get options(): Options {
    const config = vscode.workspace.getConfiguration('searchHere');
    const defaults: Options = {
      query: '',
      mode: 'all',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      respectIgnore: config.get('respectGitignore', true),
      useVSCodeExcludes: config.get('useVSCodeExcludes', true),
      hidden: false,
      include: '',
      exclude: '',
      scopeId: 'project',
    };
    const stored = this.ctx.workspaceState.get<Partial<Options>>(OPTIONS_KEY, {});
    const options = { ...defaults, ...stored };
    if (!this.scopes().some((s) => s.id === options.scopeId)) {
      options.scopeId = 'project';
    }
    return options;
  }

  /** Saves options. `notify` tells every open search view to refresh (and optionally search again). */
  async setOptions(patch: Partial<Options>, notify?: { rerun: boolean }): Promise<void> {
    await this.ctx.workspaceState.update(OPTIONS_KEY, { ...this.options, ...patch });
    if (notify) {
      this.emitter.fire({ options: true, rerun: notify.rerun });
    }
  }

  scopes(): ScopeDef[] {
    const fromSettings = vscode.workspace
      .getConfiguration('searchHere')
      .get<Partial<StoredScope>[]>('scopes', [])
      .filter((s) => s && typeof s.name === 'string')
      .map<ScopeDef>((s, i) => ({
        id: `settings:${i}:${s.name}`,
        name: s.name!,
        kind: 'settings',
        icon: 'settings',
        paths: splitPatterns(s.paths),
        include: splitPatterns(s.include),
        exclude: splitPatterns(s.exclude),
      }));
    const workspace = this.ctx.workspaceState
      .get<StoredScope[]>(SCOPES_KEY, [])
      .map<ScopeDef>((s) => ({ ...s, kind: 'workspace', icon: 'bookmark' }));
    const global = this.ctx.globalState
      .get<StoredScope[]>(SCOPES_KEY, [])
      .map<ScopeDef>((s) => ({ ...s, kind: 'global', icon: 'globe' }));
    return [...BUILTIN_SCOPES, ...fromSettings, ...workspace, ...global];
  }

  scope(id: string): ScopeDef {
    return this.scopes().find((s) => s.id === id) ?? BUILTIN_SCOPES[0];
  }

  private memento(kind: 'workspace' | 'global'): vscode.Memento {
    return kind === 'workspace' ? this.ctx.workspaceState : this.ctx.globalState;
  }

  async saveScope(scope: ScopeDef): Promise<void> {
    if (scope.kind !== 'workspace' && scope.kind !== 'global') {
      return;
    }
    const memento = this.memento(scope.kind);
    const list = memento.get<StoredScope[]>(SCOPES_KEY, []).filter((s) => s.id !== scope.id);
    list.push({ id: scope.id, name: scope.name, paths: scope.paths, include: scope.include, exclude: scope.exclude });
    await memento.update(SCOPES_KEY, list);
    this.emitter.fire({ scopes: true });
  }

  async deleteScope(id: string): Promise<void> {
    for (const kind of ['workspace', 'global'] as const) {
      const memento = this.memento(kind);
      const list = memento.get<StoredScope[]>(SCOPES_KEY, []);
      if (list.some((s) => s.id === id)) {
        await memento.update(SCOPES_KEY, list.filter((s) => s.id !== id));
      }
    }
    if (this.options.scopeId === id) {
      await this.setOptions({ scopeId: 'project' }, { rerun: true });
    }
    this.emitter.fire({ scopes: true });
  }

  dispose(): void {
    this.configSub.dispose();
    this.emitter.dispose();
  }
}
