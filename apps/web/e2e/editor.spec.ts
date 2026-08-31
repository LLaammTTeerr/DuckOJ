/**
 * The box the whole judge exists for, on the screen it is actually used on
 * (D84, re-measured after FE-2 rebuilt the layout around it in D136/D139).
 *
 * jsdom renders CodeMirror's DOM but lays out none of it, so every claim here
 * — "the editor is on screen at 390px", "the counter is legible", "the
 * shortcut hint is not clipped" — is invisible to a green unit suite. The one
 * that matters most is the last: 40vh of editor plus a soft keyboard is the
 * whole of a phone screen, and a tools row that wraps wrong pushes the buffer
 * off the bottom.
 *
 * Driven entirely by `page.route` and plain navigations, FE-3's states.spec
 * pattern: no `page.request` writes and no sign-in, which is what lets this
 * run against `vite preview` AND against the live stack unchanged (D82 refuses
 * a cookie-authenticated write whose `Origin` is the preview port). The submit
 * screen asks the API for exactly one thing — `/auth/me` — because the
 * language list is a module constant, so a mocked viewer is the entire setup.
 */
import { expect, test, type Page } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

/** A signed-in pupil, so the submit screen renders its real form. */
const ME = {
  id: 1,
  username: 'hocsinh1',
  displayName: 'Học sinh 1',
  globalRole: 'user',
  email: 'a@b.c',
  emailVerified: true,
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function signedIn(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
}

/** The editor is lazy (D84 code-splits its 505 kB), so it arrives late. */
async function openEditor(page: Page): Promise<void> {
  await page.goto('/submit?problem=aplusb');
  await page.locator('.cm-editor').waitFor({ state: 'visible' });
}

/** WCAG relative luminance, on an `rgb()`/`rgba()` string. */
function luminance(colour: string): number {
  const [r, g, b] = colour.match(/[\d.]+/g)!.slice(0, 3).map(Number) as [number, number, number];
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test.describe('the submit editor at 390px', () => {
  test('the buffer, the tools and the counter all fit on the phone', async ({ page }) => {
    await signedIn(page);
    await page.setViewportSize(PHONE);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openEditor(page);

      // Nothing on this screen pushes the page sideways. FE-1 measured 170px
      // of this on `/problems`; the editor is the widest single thing in the
      // app and is exactly where it would come back.
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(over, `[${scheme}] the submit page scrolls sideways by ${String(over)}px`).toBeLessThanOrEqual(0);

      // The editor itself, and every control above it, inside the viewport.
      for (const [what, locator] of [
        ['editor', page.locator('.cm-editor')],
        ['file picker', page.locator('.file-pick')],
        ['size counter', page.locator('.editor-size')],
        ['submit button', page.getByRole('button', { name: /Nộp bài/ })],
      ] as const) {
        const box = await locator.boundingBox();
        expect(box, `[${scheme}] no ${what} rendered`).not.toBeNull();
        expect(
          Math.round(box!.x + box!.width),
          `[${scheme}] the ${what} ends ${String(Math.round(box!.x + box!.width))}px across a 390px screen`,
        ).toBeLessThanOrEqual(PHONE.width);
        expect(box!.x, `[${scheme}] the ${what} starts off the left edge`).toBeGreaterThanOrEqual(0);
      }

      // 40vh of buffer is D84's phone rule; anything much less and a pupil is
      // typing a program through a letterbox.
      const editor = (await page.locator('.cm-editor').boundingBox())!;
      expect(
        Math.round(editor.height),
        `[${scheme}] the editor is only ${String(Math.round(editor.height))}px tall`,
      ).toBeGreaterThanOrEqual(220);
    }
  });

  test('the counter and the Ctrl/Cmd+Enter hint are legible, light and dark', async ({ page }) => {
    await signedIn(page);
    await page.setViewportSize(PHONE);

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openEditor(page);

      // The shortcut is the difference between a pupil who submits with two
      // keys and one who hunts for the button under a soft keyboard, so it is
      // named beside the editor rather than in a help page — and it has to be
      // READABLE to be discoverable at all.
      const hint = page.locator('.editor-size .muted');
      await expect(hint).toContainText('Ctrl/Cmd + Enter');

      const seen = await page.evaluate(() => {
        const el = document.querySelector('.editor-size');
        if (!el) return null;
        const style = getComputedStyle(el);
        const muted = el.querySelector('.muted');
        let node: Element | null = el;
        let background = 'rgba(0, 0, 0, 0)';
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && !bg.startsWith('rgba(0, 0, 0, 0')) {
            background = bg;
            break;
          }
          node = node.parentElement;
        }
        return {
          size: Number.parseFloat(style.fontSize),
          colour: style.color,
          hint: muted ? getComputedStyle(muted).color : style.color,
          background,
        };
      });
      expect(seen, `[${scheme}] no size counter in the DOM`).not.toBeNull();

      // 12px is the floor below which a mono digit on a phone stops being a
      // number and becomes a smudge.
      expect(seen!.size, `[${scheme}] the counter is ${String(seen!.size)}px`).toBeGreaterThanOrEqual(12);
      for (const [what, colour] of [
        ['counter', seen!.colour],
        ['shortcut hint', seen!.hint],
      ] as const) {
        const ratio = contrast(colour, seen!.background);
        expect(
          ratio,
          `[${scheme}] the ${what} sits at ${ratio.toFixed(2)}:1 (${colour} on ${seen!.background})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('a draft left behind announces itself above the buffer it filled', async ({ page }) => {
    await signedIn(page);
    await page.setViewportSize(PHONE);
    // D84 stores per (problem, language); this is the key `draftKey` builds.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem(
          'duckoj.draft.v1:aplusb:cpp17',
          'int main(){ return 41; }\n// unfinished',
        );
      } catch {
        /* a browser with site data blocked simply has no draft */
      }
    });
    await openEditor(page);

    // The restore has to be SEEN, not merely performed: a buffer that quietly
    // fills itself with code the pupil does not remember writing is worse
    // than an empty one.
    const notice = page.locator('.editor-note[role="status"]');
    await expect(notice).toBeVisible();
    const box = (await notice.boundingBox())!;
    const editor = (await page.locator('.cm-editor').boundingBox())!;
    expect(box.y, 'the draft notice is not above the editor it describes').toBeLessThan(editor.y);
    expect(Math.round(box.x + box.width), 'the draft notice runs off the phone').toBeLessThanOrEqual(
      PHONE.width,
    );
    await expect(page.locator('.cm-content')).toContainText('return 41');
  });
});
