// day-con-tang — model solution: patience sorting, O(N log N).
//
// `tails[k]` is the smallest possible last element of a strictly increasing
// subsequence of length k+1. `lower_bound` (not `upper_bound`) is what makes
// this *strictly* increasing: an equal value replaces rather than extends,
// so a run of equal numbers contributes one element, not several.
#include <bits/stdc++.h>

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    int n = 0;
    std::cin >> n;
    std::vector<int> tails;
    tails.reserve(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
        int x = 0;
        std::cin >> x;
        auto it = std::lower_bound(tails.begin(), tails.end(), x);
        if (it == tails.end()) tails.push_back(x);
        else *it = x;
    }
    std::cout << tails.size() << '\n';
    return 0;
}
