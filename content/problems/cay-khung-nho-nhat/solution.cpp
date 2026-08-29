// cay-khung-nho-nhat — model solution: Kruskal over a DSU.
//
// Sort the edges once, take an edge whenever it joins two different
// components. If fewer than N-1 edges are taken the graph is disconnected
// and there is no spanning tree at all — that case prints -1 rather than
// the weight of a spanning *forest*, which would be a different quantity
// wearing the same name.
#include <bits/stdc++.h>

struct Dsu {
    std::vector<int> parent, rank_;
    explicit Dsu(int n) : parent(static_cast<size_t>(n) + 1), rank_(static_cast<size_t>(n) + 1, 0) {
        for (int i = 0; i <= n; ++i) parent[static_cast<size_t>(i)] = i;
    }
    int find(int x) {
        while (parent[static_cast<size_t>(x)] != x) {
            parent[static_cast<size_t>(x)] = parent[static_cast<size_t>(parent[static_cast<size_t>(x)])];
            x = parent[static_cast<size_t>(x)];
        }
        return x;
    }
    bool unite(int a, int b) {
        a = find(a);
        b = find(b);
        if (a == b) return false;
        if (rank_[static_cast<size_t>(a)] < rank_[static_cast<size_t>(b)]) std::swap(a, b);
        parent[static_cast<size_t>(b)] = a;
        if (rank_[static_cast<size_t>(a)] == rank_[static_cast<size_t>(b)]) ++rank_[static_cast<size_t>(a)];
        return true;
    }
};

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n = 0, m = 0;
    std::cin >> n >> m;

    std::vector<std::tuple<int, int, int>> edges;
    edges.reserve(static_cast<size_t>(m));
    for (int i = 0; i < m; ++i) {
        int u = 0, v = 0, w = 0;
        std::cin >> u >> v >> w;
        edges.emplace_back(w, u, v);
    }
    std::sort(edges.begin(), edges.end());

    Dsu dsu(n);
    long long total = 0;
    int taken = 0;
    for (auto [w, u, v] : edges) {
        if (dsu.unite(u, v)) {
            total += w;
            ++taken;
            if (taken == n - 1) break;
        }
    }

    std::cout << (taken == n - 1 ? total : -1) << '\n';
    return 0;
}
