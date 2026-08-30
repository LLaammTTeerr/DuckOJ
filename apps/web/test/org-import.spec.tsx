/**
 * D61's two web surfaces: the roster import panel on an organization page,
 * and the password change an imported account cannot get past.
 *
 * The branches that matter are the ones a screenshot cannot show — that the
 * panel is offered to an owner and to nobody else, that a 422 is rendered
 * ROW BY ROW rather than as one sentence, that "create" is unreachable until
 * the list has been checked, and that the credentials are on the page three
 * ways at once because each of the three fails somewhere.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../src/api.js', () => ({
  api: {
    GET: (...a: unknown[]) => get(...a),
    POST: (...a: unknown[]) => post(...a),
    DELETE: () => Promise.resolve({ data: undefined }),
    PATCH: () => Promise.resolve({ data: undefined }),
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const { OrgPage } = await import('../src/routes/orgs.js');
const { ChangePasswordPage, PasswordGate } = await import('../src/routes/password.js');
const { en, LocaleProvider } = await import('../src/i18n/index.js');

/**
 * Rendered in ENGLISH deliberately, though Vietnamese is the product default
 * (D18): the assertions below quote `en[...]` by key, so a wording change in
 * either catalogue moves the test with the app rather than breaking it, and
 * `test/i18n.spec.tsx` already proves the two catalogues cover the same keys.
 */
function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider initialLocale="en">{ui}</LocaleProvider>
    </QueryClientProvider>,
  );
}

const ORG = {
  id: 1,
  slug: 'thpt-a',
  name: 'THPT A',
  about: null,
  visibility: 'public',
  joinPolicy: 'request',
  createdAt: '2026-01-01T00:00:00Z',
};

function serve(myRole: string | null, globalRole = 'user') {
  get.mockImplementation((path: string) => {
    if (path === '/auth/me')
      return Promise.resolve({
        data: { username: 'hieutruong', displayName: 'Hiệu trưởng', globalRole, mustChangePassword: false },
      });
    if (path === '/orgs/{slug}') return Promise.resolve({ data: { ...ORG, myRole } });
    if (path === '/orgs/{slug}/members')
      return Promise.resolve({ data: { items: [], nextCursor: null } });
    return Promise.resolve({ data: [] });
  });
}

afterEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('the roster import panel', () => {
  it('is offered to an owner and to a global admin, and to nobody else', async () => {
    for (const [myRole, globalRole, expected] of [
      ['owner', 'user', true],
      ['admin', 'user', false],
      ['member', 'user', false],
      [null, 'admin', true],
    ] as const) {
      serve(myRole, globalRole);
      const view = wrap(<OrgPage slug="thpt-a" />);
      await screen.findByRole('heading', { name: 'THPT A' });
      // The API refuses an organization `admin` (D61), so offering them a
      // control that always 403s is worse than not having one.
      expect(screen.queryByRole('heading', { name: en['import.title'] }) !== null).toBe(expected);
      view.unmount();
    }
  });

  it('checks before it creates, and cannot create a list that was never checked', async () => {
    serve('owner');
    post.mockResolvedValue({
      data: {
        rows: [
          { username: 'hs001', displayName: 'Nguyễn Văn A', email: 'x@y.z', emailProvided: true },
          { username: 'hs002', displayName: 'Trần Thị B', email: 'hs002@thpt-a.import.invalid', emailProvided: false },
        ],
      },
    });
    wrap(<OrgPage slug="thpt-a" />);
    await screen.findByRole('heading', { name: en['import.title'] });

    const confirm = screen.getByRole('button', { name: en['import.confirm'] });
    // Nothing has been checked, so there is nothing to confirm.
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(en['import.csv']), 'hs001,A');
    await userEvent.click(screen.getByRole('button', { name: en['import.check'] }));

    await screen.findByText('hs001');
    expect(post).toHaveBeenCalledWith(
      '/orgs/{slug}/members/import',
      expect.objectContaining({ body: expect.objectContaining({ dryRun: true }) }),
    );
    // The placeholder address is shown as "none", not as a mailbox anybody
    // could write to.
    expect(screen.getByText(en['import.noEmail'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en['import.confirm'] })).toBeEnabled();
  });

  it('renders a 422 row by row, not as one sentence', async () => {
    serve('owner');
    post.mockResolvedValue({
      error: {
        status: 422,
        code: 'member_import_invalid',
        detail: '2 row(s) cannot be imported; nothing was created.',
        fields: {
          'rows[3].username': ['Somebody already has that username.'],
          'rows[1].displayName': ['A display name is 1 to 100 characters.'],
        },
      },
    });
    wrap(<OrgPage slug="thpt-a" />);
    await screen.findByRole('heading', { name: en['import.title'] });
    await userEvent.type(screen.getByLabelText(en['import.csv']), 'x,y');
    await userEvent.click(screen.getByRole('button', { name: en['import.check'] }));

    await screen.findByText('Somebody already has that username.');
    expect(screen.getByText('A display name is 1 to 100 characters.')).toBeInTheDocument();
    // Sorted by row, so the table reads in the order of the file the teacher
    // is looking at.
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    expect(rows.findIndex((r) => r.includes('displayName'))).toBeLessThan(
      rows.findIndex((r) => r.includes('username')),
    );
    // Still nothing to confirm: the file was refused.
    expect(screen.getByRole('button', { name: en['import.confirm'] })).toBeDisabled();
  });

  it('shows the credentials as a printable table, a download AND copyable text', async () => {
    serve('owner');
    const created = [{ username: 'hs001', displayName: 'Nguyễn Văn A', password: 'Kt7mQr4xVb9n' }];
    post.mockImplementation((_path: string, init: { body: { dryRun: boolean } }) =>
      init.body.dryRun
        ? Promise.resolve({
            data: { rows: [{ username: 'hs001', displayName: 'Nguyễn Văn A', email: 'e', emailProvided: false }] },
          })
        : Promise.resolve({
            data: { created, csv: 'username,displayName,password\nhs001,Nguyễn Văn A,Kt7mQr4xVb9n\n' },
          }),
    );
    wrap(<OrgPage slug="thpt-a" />);
    await screen.findByRole('heading', { name: en['import.title'] });
    await userEvent.type(screen.getByLabelText(en['import.csv']), 'hs001,A');
    await userEvent.click(screen.getByRole('button', { name: en['import.check'] }));
    await screen.findByRole('button', { name: en['import.confirm'] });
    await userEvent.click(screen.getByRole('button', { name: en['import.confirm'] }));

    await screen.findByRole('heading', { name: en['import.credentials'] });
    // The password is shown once and stored nowhere, so the warning is not
    // decoration.
    expect(screen.getByRole('alert')).toHaveTextContent(en['import.credentialsWarning']);
    expect(screen.getByText('Kt7mQr4xVb9n')).toBeInTheDocument();

    // Three ways out, because each of the three fails somewhere: a download
    // is inert in an embedded viewer, a print dialog is missing on some
    // tablets, and a selection always works.
    const table = document.querySelector('.print-credentials');
    expect(table).not.toBeNull();
    const link = screen.getByRole('link', { name: en['import.download'] });
    expect(link).toHaveAttribute('download', 'thpt-a-accounts.csv');
    expect(screen.getByLabelText(en['import.copyLabel'])).toHaveValue(
      'username,displayName,password\nhs001,Nguyễn Văn A,Kt7mQr4xVb9n\n',
    );
  });
});

describe('the roster import splits a large file (D61 amended)', () => {
  /** `n` data rows, headerless, exactly what a mail merge produces. */
  function roster(n: number, from = 0): string {
    return (
      Array.from({ length: n }, (_, i) => `hs${String(from + i).padStart(4, '0')},Pupil ${String(from + i)}`).join(
        '\n',
      ) + '\n'
    );
  }

  function bodies(): { csv: string; dryRun: boolean }[] {
    return post.mock.calls.map((call) => (call[1] as { body: { csv: string; dryRun: boolean } }).body);
  }

  it('sends 500 rows at a time and shows how far it has got', async () => {
    serve('owner');
    post.mockImplementation((_path: string, init: { body: { csv: string; dryRun: boolean } }) => {
      const rows = init.body.csv.trim().split('\n').map((line) => {
        const [username, displayName] = line.split(',');
        return { username, displayName, email: 'e', emailProvided: false };
      });
      return init.body.dryRun
        ? Promise.resolve({ data: { rows } })
        : Promise.resolve({
            data: {
              created: rows.map((row) => ({ ...row, password: `pw-${row.username ?? ''}` })),
              csv: rows.map((row) => `${row.username ?? ''},x,pw-${row.username ?? ''}`).join('\n') + '\n',
            },
          });
    });
    wrap(<OrgPage slug="thpt-a" />);
    await screen.findByRole('heading', { name: en['import.title'] });

    // 1,200 rows: over the server's 500-row cap, which used to be a 422 the
    // teacher had to fix with a text editor.
    await userEvent.click(screen.getByLabelText(en['import.csv']));
    await userEvent.paste(roster(1200));
    await userEvent.click(screen.getByRole('button', { name: en['import.check'] }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(3);
    });
    const checks = bodies();
    expect(checks.every((body) => body.dryRun)).toBe(true);
    // 500 data rows plus the header line every chunk now carries: a
    // headerless file's chunks declare `username,displayName,email` rather
    // than leaving the server to detect a header per request and eat the
    // pupil whose row happens to open one.
    expect(checks.map((body) => body.csv.trim().split('\n').length)).toEqual([501, 501, 201]);
    expect(checks.every((body) => body.csv.startsWith('username,displayName,email\n'))).toBe(true);

    post.mockClear();
    await userEvent.click(screen.getByRole('button', { name: en['import.confirm'] }));
    await screen.findByRole('heading', { name: en['import.credentials'] });
    const creates = bodies();
    expect(creates).toHaveLength(3);
    expect(creates.every((body) => !body.dryRun)).toBe(true);
    // One merged table: a teacher must not be handed three lists to
    // reconcile, and the copyable text is the whole class.
    expect(screen.getByText('pw-hs0000')).toBeInTheDocument();
    expect(screen.getByText('pw-hs1199')).toBeInTheDocument();
    expect((screen.getByLabelText(en['import.copyLabel']) as HTMLTextAreaElement).value).toContain(
      'hs1199',
    );
  }, 30_000);

  it('refuses a username the file repeats across two chunks, before creating anything', async () => {
    serve('owner');
    post.mockResolvedValue({ data: { rows: [] } });
    wrap(<OrgPage slug="thpt-a" />);
    await screen.findByRole('heading', { name: en['import.title'] });

    // The server validates one request against itself; a repeat that lands
    // in a different chunk passes every check and then dies on the unique
    // index, AFTER the earlier chunks have created accounts.
    await userEvent.click(screen.getByLabelText(en['import.csv']));
    await userEvent.paste(`${roster(600)}hs0001,Nguyễn Văn A lần hai\n`);
    await userEvent.click(screen.getByRole('button', { name: en['import.check'] }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/hs0001/);
    expect(post).not.toHaveBeenCalled();
  }, 30_000);

  it('stops at the chunk that failed and keeps the accounts already created', async () => {
    serve('owner');
    let creates = 0;
    post.mockImplementation((_path: string, init: { body: { csv: string; dryRun: boolean } }) => {
      if (init.body.dryRun) return Promise.resolve({ data: { rows: [] } });
      creates += 1;
      if (creates === 1) {
        return Promise.resolve({
          data: {
            created: [{ username: 'hs0000', displayName: 'A', password: 'pw-a' }],
            csv: 'hs0000,A,pw-a\n',
          },
        });
      }
      return Promise.resolve({ error: { detail: 'An import ran in the last minute.' } });
    });
    wrap(<OrgPage slug="thpt-a" />);
    await screen.findByRole('heading', { name: en['import.title'] });
    await userEvent.click(screen.getByLabelText(en['import.csv']));
    await userEvent.paste(roster(600));
    await userEvent.click(screen.getByRole('button', { name: en['import.check'] }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en['import.confirm'] })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole('button', { name: en['import.confirm'] }));

    // The passwords of the first chunk exist nowhere else. Losing them to a
    // failure in the second is the F8 report's own concern.
    expect(await screen.findByText('pw-a')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').map((el) => el.textContent ?? '').join(' ')).toMatch(
      /last minute/,
    );
  }, 30_000);
});

describe('the forced password change (D61)', () => {
  function serveMe(mustChangePassword: boolean) {
    get.mockResolvedValue({
      data: { username: 'hs001', displayName: 'A', globalRole: 'user', mustChangePassword },
    });
  }

  it('replaces the whole page while the flag is set, and steps aside once it is not', async () => {
    serveMe(true);
    const flagged = wrap(
      <PasswordGate>
        <p>trang binh thuong</p>
      </PasswordGate>,
    );
    await screen.findByRole('heading', { name: en['password.title'] });
    expect(screen.queryByText('trang binh thuong')).toBeNull();
    flagged.unmount();

    serveMe(false);
    wrap(
      <PasswordGate>
        <p>trang binh thuong</p>
      </PasswordGate>,
    );
    await screen.findByText('trang binh thuong');
    expect(screen.queryByRole('heading', { name: en['password.title'] })).toBeNull();
  });

  it('does not ask a flagged account for a password it never chose', async () => {
    serveMe(true);
    post.mockResolvedValue({ data: undefined });
    wrap(<ChangePasswordPage />);
    await screen.findByRole('heading', { name: en['password.title'] });

    // The password on record was printed on a sheet handed round a classroom.
    expect(screen.queryByLabelText(en['password.current'])).toBeNull();

    await userEvent.type(screen.getByLabelText(en['password.new']), 'mat-khau-moi');
    await userEvent.type(screen.getByLabelText(en['password.confirm']), 'mat-khau-moi');
    await userEvent.click(screen.getByRole('button', { name: en['password.save'] }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/auth/password/change', {
        body: { newPassword: 'mat-khau-moi' },
      });
    });
  });

  it('requires the current password from everyone else, and refuses a mismatch', async () => {
    serveMe(false);
    wrap(<ChangePasswordPage />);
    await screen.findByRole('heading', { name: en['password.title'] });

    const save = screen.getByRole('button', { name: en['password.save'] });
    await userEvent.type(screen.getByLabelText(en['password.new']), 'mat-khau-moi');
    await userEvent.type(screen.getByLabelText(en['password.confirm']), 'mat-khau-khac');
    expect(screen.getByText(en['password.mismatch'])).toBeInTheDocument();
    expect(save).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(en['password.confirm']));
    await userEvent.type(screen.getByLabelText(en['password.confirm']), 'mat-khau-moi');
    // Still disabled: an unattended browser must not be one click away from
    // an account takeover.
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText(en['password.current']), 'cu');
    expect(save).toBeEnabled();
  });

  it('refuses a new password shorter than the contract allows, before sending it', async () => {
    serveMe(false);
    wrap(<ChangePasswordPage />);
    await screen.findByRole('heading', { name: en['password.title'] });
    await userEvent.type(screen.getByLabelText(en['password.current']), 'cu');
    await userEvent.type(screen.getByLabelText(en['password.new']), 'ngan');
    await userEvent.type(screen.getByLabelText(en['password.confirm']), 'ngan');
    expect(screen.getByRole('button', { name: en['password.save'] })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });
});
