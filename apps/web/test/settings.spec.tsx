/**
 * D57 — `/account/settings`, and the rule that a preference stored on the
 * ACCOUNT beats the one this browser remembers.
 *
 * Two properties carry this file. `''` in either select must reach the API as
 * `null` — the instruction that CLEARS a preference, which is a different
 * thing from omitting the field — and the shell must adopt a server locale
 * once per identity rather than on every render, or the nav's own `VI | EN`
 * toggle would be undone a millisecond after the reader pressed it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../src/api.js', () => ({
  api: { GET: (...a: unknown[]) => get(...a), PATCH: (...a: unknown[]) => patch(...a) },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { SettingsPage } = await import('../src/routes/settings.js');
const { LocaleProvider, useLocale, formatTimestamp } = await import('../src/i18n/index.js');
const { PreferenceSync } = await import('../src/preferences.js');
const { meQueryOptions } = await import('../src/me.js');

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const ME = {
  id: 4,
  username: 'kim',
  email: 'kim@example.com',
  displayName: 'Kim',
  globalRole: 'user',
  locale: null as string | null,
  timezone: null as string | null,
  totpEnabled: false,
  recoveryCodesRemaining: 0,
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function routeGet(me: unknown): void {
  get.mockImplementation((path: string) =>
    Promise.resolve({ data: path === '/auth/me' ? me : null }),
  );
}

afterEach(() => {
  get.mockReset();
  patch.mockReset();
});

describe('SettingsPage', () => {
  it('shows "follow my browser" for an account that has chosen nothing', async () => {
    routeGet(ME);
    wrap(<SettingsPage />);
    expect(await screen.findByLabelText(/Tên hiển thị/)).toHaveValue('Kim');
    expect(screen.getByLabelText(/Ngôn ngữ/)).toHaveValue('');
    expect(screen.getByLabelText(/Múi giờ/)).toHaveValue('');
  });

  it('sends a chosen locale and zone, and null for "follow my browser"', async () => {
    routeGet({ ...ME, locale: 'en', timezone: 'Europe/Paris' });
    patch.mockResolvedValue({ data: {} });
    wrap(<SettingsPage />);

    expect(await screen.findByLabelText(/Ngôn ngữ/)).toHaveValue('en');
    await userEvent.selectOptions(screen.getByLabelText(/Múi giờ/), '');
    await userEvent.click(screen.getByRole('button', { name: /Lưu cài đặt/ }));

    // `null`, never omitted: the form shows both, so it has to be able to
    // save "none" as well as a value.
    expect(patch.mock.calls[0]![1].body).toMatchObject({
      displayName: 'Kim',
      locale: 'en',
      timezone: null,
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/Đã lưu/);
  });

  it('keeps a zone the account holds that is not on the short list', async () => {
    routeGet({ ...ME, timezone: 'Pacific/Auckland' });
    wrap(<SettingsPage />);
    // The API accepts any zone Intl can resolve; the picker is a convenience,
    // never a limit on what an account may already hold.
    expect(await screen.findByLabelText(/Múi giờ/)).toHaveValue('Pacific/Auckland');
  });

  it('surfaces the server refusal verbatim and never wedges the button', async () => {
    routeGet(ME);
    patch.mockResolvedValue({ error: { code: 'validation_failed', detail: 'not a zone' } });
    wrap(<SettingsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Lưu cài đặt/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a zone');
    expect(screen.getByRole('button', { name: /Lưu cài đặt/ })).toBeEnabled();
  });
});

describe('the reader’s own zone', () => {
  it('is what an absolute timestamp is rendered in, and null is the browser’s', () => {
    const iso = '2026-03-01T23:30:00.000Z';
    // 23:30 UTC is the 2nd in Ho Chi Minh City and still the 1st in London —
    // a zone that changes the DATE, so this cannot pass by coincidence.
    expect(formatTimestamp(iso, 'vi', 'Asia/Ho_Chi_Minh')).toContain('2/3/2026');
    expect(formatTimestamp(iso, 'vi', 'Europe/London')).toContain('1/3/2026');
    // `null` passes no option at all, which is the behaviour this app had
    // before anybody could choose a zone.
    expect(formatTimestamp(iso, 'vi', null)).toBe(formatTimestamp(iso, 'vi'));
  });
});

describe('adopting the account’s locale', () => {
  /**
   * `who` exists so a test can await the `['me']` query SETTLING rather than
   * awaiting a locale that may never change — without it, "applies nothing"
   * would pass against a sync that had simply not run yet.
   */
  function Probe() {
    const { locale, setLocale, timeZone } = useLocale();
    const me = useQuery(meQueryOptions);
    return (
      <>
        <span data-testid="locale">{locale}</span>
        <span data-testid="zone">{timeZone ?? 'none'}</span>
        <span data-testid="who">{me.data?.username ?? '…'}</span>
        <button type="button" onClick={() => setLocale('vi')}>
          toggle
        </button>
      </>
    );
  }

  it('a stored server locale is applied over the browser’s remembered one', async () => {
    routeGet({ ...ME, locale: 'en', timezone: 'Europe/Paris' });
    wrap(
      <LocaleProvider initialLocale="vi">
        <PreferenceSync />
        <Probe />
      </LocaleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
    expect(screen.getByTestId('zone')).toHaveTextContent('Europe/Paris');
  });

  it('leaves the reader alone afterwards, so the nav toggle still works', async () => {
    routeGet({ ...ME, locale: 'en' });
    wrap(
      <LocaleProvider initialLocale="vi">
        <PreferenceSync />
        <Probe />
      </LocaleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    // Re-applied on every render, this would have snapped straight back.
    expect(screen.getByTestId('locale')).toHaveTextContent('vi');
  });

  it('a refetch that changed nothing does not undo the toggle', async () => {
    // The bell refetches `['me']` every minute and react-query hands back a
    // fresh object each time. A sync keyed on that object — or on nothing at
    // all — would put the reader's language back a minute after they changed
    // it, which is the failure this guard exists for.
    routeGet({ ...ME, locale: 'en' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LocaleProvider initialLocale="vi">
          <PreferenceSync />
          <Probe />
        </LocaleProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await client.refetchQueries({ queryKey: ['me'] });
    expect(screen.getByTestId('locale')).toHaveTextContent('vi');
  });

  it('a save that changed the stored locale IS adopted, same account and all', async () => {
    // The other half of the same rule: `/account/settings` invalidates
    // `['me']` for an account whose id has not moved, and a guard keyed on
    // identity would swallow exactly that.
    routeGet({ ...ME, locale: 'en' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LocaleProvider initialLocale="en">
          <PreferenceSync />
          <Probe />
        </LocaleProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('kim'));
    routeGet({ ...ME, locale: 'vi', timezone: 'Asia/Bangkok' });
    await client.refetchQueries({ queryKey: ['me'] });
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('vi'));
    expect(screen.getByTestId('zone')).toHaveTextContent('Asia/Bangkok');
  });

  it('applies nothing for an account that has chosen nothing', async () => {
    routeGet(ME);
    wrap(
      <LocaleProvider initialLocale="en">
        <PreferenceSync />
        <Probe />
      </LocaleProvider>,
    );
    // The query has SETTLED by the time `who` names the reader, so this is
    // "the sync ran and applied nothing", not "the sync has not run yet".
    expect(await screen.findByText('kim')).toBeInTheDocument();
    expect(screen.getByTestId('zone')).toHaveTextContent('none');
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
  });
});
