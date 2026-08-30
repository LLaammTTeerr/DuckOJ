import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.js';
import { createQueryClient } from './query.js';
import { LocaleProvider } from './i18n/index.js';
import './app.css';

// Not `new QueryClient()`: the default retry policy hammers a 404 three
// more times over seven seconds of backoff. See src/query.ts.
const queryClient = createQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Above the router, not inside a route: the shell's own nav (the
        language toggle included) is rendered by the root route, and every
        route below it reads the same locale. */}
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LocaleProvider>
  </StrictMode>,
);
