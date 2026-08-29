// so-nguyen-to — model solution: a plain sieve of Eratosthenes.
//
// N <= 1e7, so a byte-per-number sieve is 10 MB — comfortably inside the
// 256 MiB limit, and simpler than any bitset variant. Marking from i*i in
// steps of i is what keeps this ~O(N log log N) rather than O(N sqrt N).
#include <bits/stdc++.h>

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n = 0;
    std::cin >> n;
    if (n < 2) {
        std::cout << 0 << '\n';
        return 0;
    }
    std::vector<char> composite(static_cast<size_t>(n) + 1, 0);
    long long count = 0;
    for (long long i = 2; i <= n; ++i) {
        if (composite[static_cast<size_t>(i)]) continue;
        ++count;
        for (long long j = i * i; j <= n; j += i) composite[static_cast<size_t>(j)] = 1;
    }
    std::cout << count << '\n';
    return 0;
}
