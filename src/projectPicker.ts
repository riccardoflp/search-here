import * as path from 'path';
import * as vscode from 'vscode';
import type { Services } from './controller';
import { ALL_PROJECTS, CURRENT_PROJECT, followActiveFileEnabled, projectLabel, resolveProjectRef } from './projects';
import { Options, ProjectView } from './protocol';

export interface ProjectPickItem extends vscode.QuickPickItem {
  /** The `Options.project` value; undefined for separators. */
  value?: string;
}

/** The choices of the project selector, and the one that is selected now. */
export async function projectPickItems(services: Services): Promise<{ items: ProjectPickItem[]; active?: ProjectPickItem }> {
  const { store, engine } = services;
  const list = await store.projects.list();
  const selected = store.options.project;
  const items: ProjectPickItem[] = [{ label: '$(root-folder) All projects', description: 'the whole workspace', value: ALL_PROJECTS }];
  if (followActiveFileEnabled()) {
    const now = engine.projects.containing(engine.activeFolder, list);
    items.push({
      label: '$(target) Current project',
      description: `follows the active file${now ? ` · now ${now.name}` : ''}`,
      value: CURRENT_PROJECT,
    });
  }
  const folders = list.filter((p) => p.kind === 'folder');
  const subs = list.filter((p) => p.kind === 'sub');
  if (folders.length) {
    items.push({ label: 'Workspace folders', kind: vscode.QuickPickItemKind.Separator });
    items.push(...folders.map((p) => ({ label: `$(folder) ${p.name}`, description: p.path, value: p.path })));
  }
  if (subs.length) {
    items.push({ label: 'Projects', kind: vscode.QuickPickItemKind.Separator });
    items.push(
      ...subs.map((p) => {
        const dir = path.posix.dirname(p.name);
        return {
          label: `$(package) ${path.posix.basename(p.name)}`,
          description: [dir === '.' ? '' : dir, p.marker].filter(Boolean).join(' · '),
          value: p.path,
        };
      }),
    );
  }
  const selectedDir = selected && selected !== CURRENT_PROJECT ? path.normalize(selected) : selected;
  const active = items.find((i) => i.value !== undefined && (i.value === selectedDir || (i.value && path.normalize(i.value) === selectedDir)));
  return { items, active };
}

/**
 * Selects a project and searches again. A scope bound to another project is left for the
 * Project scope, since the pick would not apply to it.
 */
export async function applyProject(services: Services, value: string): Promise<void> {
  const { store } = services;
  const options = store.options;
  const patch: Partial<Options> = { project: value };
  const scope = store.scope(options.scopeId);
  if (scope.project) {
    const bound = resolveProjectRef(scope.project);
    const picked = value && value !== CURRENT_PROJECT ? path.normalize(value) : null;
    if (!bound || picked !== bound) patch.scopeId = 'project';
  }
  await store.setOptions(patch, { rerun: true });
}

/** Shows the project selector as a dialog (the search view's button and "Select Project"). */
export async function pickProject(services: Services): Promise<void> {
  const { items, active } = await projectPickItems(services);
  if (items.length < 2 || (items.length === 2 && items[1].value === CURRENT_PROJECT)) {
    vscode.window.showInformationMessage(
      'Search Here found no projects: open a multi-root workspace, or check the "searchHere.projects" settings.',
    );
    return;
  }
  const picked = await showPick(items, { title: 'Search Here · Project', placeholder: 'Pick the project to search in', active });
  if (picked?.value !== undefined) await applyProject(services, picked.value);
}

/** A single choice dialog that starts on `active` (showQuickPick cannot), matching descriptions too. */
export async function showPick<T extends vscode.QuickPickItem>(
  items: T[],
  options: { title: string; placeholder: string; active?: T },
): Promise<T | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  qp.title = options.title;
  qp.placeholder = options.placeholder;
  qp.matchOnDescription = true;
  qp.items = items;
  if (options.active) qp.activeItems = [options.active];
  const picked = await new Promise<T | undefined>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.activeItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  return picked;
}

/** What the selector shows; null when there is nothing to pick from. */
export async function describeProject(services: Services): Promise<ProjectView | null> {
  const { store, engine } = services;
  const options = store.options;
  const scope = store.scope(options.scopeId);
  const list = await store.projects.list();
  if (!list.length && !scope.project) return null;
  const effective = await engine.project(options, scope);
  const name = effective.dir ? projectLabel(effective.dir) : undefined;
  switch (effective.source) {
    case 'scope':
      return {
        label: name ?? `${scope.project} (not found)`,
        tooltip: `The scope "${scope.name}" always searches in ${name ?? scope.project}. Click to pick another project.`,
        locked: true,
      };
    case 'current':
      return {
        label: `Current: ${name ?? 'whole workspace'}`,
        tooltip: `Follows the active file: searching in ${name ?? 'the whole workspace'}. Click to pick a project.`,
        locked: false,
      };
    case 'picked':
      return { label: name!, tooltip: `Searching only in ${effective.dir}. Click to pick another project.`, locked: false };
    default:
      return { label: 'All projects', tooltip: 'Searching the whole workspace. Click to pick a project.', locked: false };
  }
}
