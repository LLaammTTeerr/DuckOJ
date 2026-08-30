/**
 * @tag        wrong-answer
 * @expect     g1=WA
 * @algorithm  Prints the difference instead of the sum.
 * @why-wrong  Wrong operator; every test with b != 0 catches it.
 * @complexity O(1)
 */
#include <iostream>

int main() {
  long long a = 0, b = 0;
  std::cin >> a >> b;
  std::cout << a - b << "\n";
  return 0;
}
