import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { useT } from '../i18n/index.js';

export function Home() {
  const t = useT();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.GET('/auth/me');
      return data ?? null;
    },
  });

  if (me.isLoading) return <p>{t('common.loading')}</p>;
  if (!me.data) return <p>{t('home.notSignedIn')}</p>;
  return (
    <p>
      {t('home.signedInPrefix')}
      {me.data.displayName}
    </p>
  );
}
