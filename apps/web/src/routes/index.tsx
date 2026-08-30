import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { read } from '../api-error.js';
import { useT } from '../i18n/index.js';

export function Home() {
  const t = useT();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      // 401 is the signed-out state, not a failure — this is the app's front
      // page and a visitor must reach it. Anything else is a real failure and
      // now says so, instead of rendering as "you are not signed in" to
      // somebody who is.
      return read(await api.GET('/auth/me'), t('home.loadError'), [401]);
    },
  });

  if (me.isLoading) return <p>{t('common.loading')}</p>;
  if (me.isError) return <p role="alert">{t('home.loadError')}</p>;
  if (!me.data) return <p>{t('home.notSignedIn')}</p>;
  return (
    <p>
      {t('home.signedInPrefix')}
      {me.data.displayName}
    </p>
  );
}
