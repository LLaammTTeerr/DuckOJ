// duong-di-ngan-nhat — model solution: Dijkstra with a binary heap.
//
// Weights are up to 1e9 and a path can use up to N-1 <= 1e5 - 1 edges, so
// the distance overflows 32 bits: `long long` throughout, and INF chosen
// well above any reachable distance but far below LLONG_MAX so that
// `dist + w` in the relaxation cannot overflow either.
#include <bits/stdc++.h>

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n = 0, m = 0;
    std::cin >> n >> m;

    std::vector<std::vector<std::pair<int, int>>> adj(static_cast<size_t>(n) + 1);
    for (int i = 0; i < m; ++i) {
        int u = 0, v = 0, w = 0;
        std::cin >> u >> v >> w;
        adj[static_cast<size_t>(u)].emplace_back(v, w);
        adj[static_cast<size_t>(v)].emplace_back(u, w);
    }

    const long long INF = std::numeric_limits<long long>::max() / 4;
    std::vector<long long> dist(static_cast<size_t>(n) + 1, INF);
    using Item = std::pair<long long, int>;
    std::priority_queue<Item, std::vector<Item>, std::greater<Item>> pq;
    dist[1] = 0;
    pq.emplace(0LL, 1);

    while (!pq.empty()) {
        auto [d, u] = pq.top();
        pq.pop();
        // Lazy deletion: a stale copy of `u` left in the heap by an earlier,
        // longer relaxation is skipped here rather than removed there.
        if (d != dist[static_cast<size_t>(u)]) continue;
        for (auto [v, w] : adj[static_cast<size_t>(u)]) {
            long long nd = d + w;
            if (nd < dist[static_cast<size_t>(v)]) {
                dist[static_cast<size_t>(v)] = nd;
                pq.emplace(nd, v);
            }
        }
    }

    long long answer = dist[static_cast<size_t>(n)];
    std::cout << (answer >= INF ? -1 : answer) << '\n';
    return 0;
}
