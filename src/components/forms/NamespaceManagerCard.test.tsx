import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NamespaceManagerCard } from './NamespaceManagerCard';
import { Header } from '@/components/layout/Header';

const { state, create, update, remove } = vi.hoisted(() => ({
  state: { principal: { role: 'admin', namespaces: ['tenant-a', 'tenant-c'] as string[] | undefined },
    names: ['tenant-a', 'tenant-b', 'tenant-c'] },
  create: vi.fn(), update: vi.fn(), remove: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({ useAuth: () => ({ principal: state.principal, logout: vi.fn() }) }));
vi.mock('@/stores/namespace', () => ({ useNamespace: () => ({ selectedNamespace: 'tenant-a', setNamespace: vi.fn(), replaceNamespaceIfCurrent: vi.fn() }) }));
vi.mock('@/stores/theme', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('@/hooks/useBffHealth', () => ({ useBffReadiness: () => ({ data: { status: 'ready' } }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/ui/Select', () => ({ Select: ({ options }: { options: { value: string }[] }) =>
  <div data-testid="header-names">{options.map((option) => <span key={option.value}>{option.value}</span>)}</div> }));
vi.mock('@/hooks/useNamespaces', () => ({
  useNamespaces: () => ({ data: state.names, isLoading: false, isSuccess: true, isFetching: false }),
  useNamespaceDetail: (name: string) => ({ data: { name, description: '' }, isSuccess: true }),
  useCreateNamespace: () => ({ mutateAsync: create, isPending: false }),
  useUpdateNamespace: () => ({ mutateAsync: update, isPending: false }),
  useDeleteNamespace: () => ({ mutateAsync: remove, isPending: false }),
  useNamespaceOccupancy: () => ({ data: { total: 0, entries: [], partial: false } }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
async function render() {
  await act(async () => root.render(<><Header onToggleSidebar={() => {}} /><NamespaceManagerCard /></>));
}
function button(text: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function click(text: string, within: ParentNode = document) {
  await act(async () => button(text, within).click());
}
async function name(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  state.principal = { role: 'admin', namespaces: ['tenant-a', 'tenant-c'] };
  create.mockReset().mockResolvedValue({ name: 'tenant-c' });
  update.mockReset().mockResolvedValue({ name: 'tenant-c' });
  remove.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('namespace manager grants', () => {
  it('shows the same granted names as the header and no controls for ungranted rows', async () => {
    await render();
    const rows = [...host.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('span')!.textContent)).toEqual(['tenant-a', 'tenant-c']);
    expect([...host.querySelectorAll('[data-testid="header-names"] span')].map((entry) => entry.textContent))
      .toEqual(['tenant-a', 'tenant-c']);
    expect(host.textContent).not.toContain('tenant-b');
    expect(rows.every((row) => button('Edit', row) && button('Delete', row))).toBe(true);
  });

  it('allows unrestricted administration but grants no rows for an empty explicit set', async () => {
    state.principal.namespaces = undefined;
    await render();
    expect(host.querySelectorAll('li')).toHaveLength(3);
    state.principal.namespaces = [];
    await render();
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(host.querySelector('[data-testid="header-names"]')!.textContent).toBe('');
  });

  it.each(['viewer', 'operator'])('hides registry write controls for %s', async (role) => {
    state.principal.role = role;
    await render();
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.textContent).not.toContain('New Namespace');
    expect(host.textContent).not.toContain('Delete');
    expect(host.textContent).not.toContain('Edit');
  });

  it('validates create and rename destinations against grants before mutation', async () => {
    await render();
    await click('New Namespace');
    await name('tenant-b');
    await click('Create');
    expect(create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Namespace access denied');
    await name('tenant-c');
    await click('Create');
    expect(create).toHaveBeenCalledWith({ name: 'tenant-c' });
    await click('Edit', host.querySelector('li')!);
    await name('tenant-b');
    await click('Save');
    expect(update).not.toHaveBeenCalled();
    await name('tenant-c');
    await click('Save');
    expect(update).toHaveBeenCalledWith({ name: 'tenant-a', data: { name: 'tenant-c' } });
  });

  it('unmounts an open destructive dialog when its target grant disappears', async () => {
    await render();
    await click('Delete', host.querySelector('li')!);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    state.principal.namespaces = ['tenant-c'];
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
