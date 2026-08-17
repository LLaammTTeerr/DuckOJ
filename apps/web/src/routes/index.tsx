import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

export function Home() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.GET('/auth/me');
      return data ?? null;
    },
  });

  if (me.isLoading) return <p>Loading…</p>;
  if (!me.data) return <p>Not signed in.</p>;
  return <p>Signed in as {me.data.displayName}.</p>;
}
