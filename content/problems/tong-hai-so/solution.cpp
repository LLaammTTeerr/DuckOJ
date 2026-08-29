// tong-hai-so — model solution.
//
// |a|, |b| <= 1e9, so the sum fits in 32 bits, but `long long` costs
// nothing here and removes the one way this problem is ever failed.
#include <bits/stdc++.h>

int main() {
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    long long a = 0, b = 0;
    std::cin >> a >> b;
    std::cout << a + b << '\n';
    return 0;
}
