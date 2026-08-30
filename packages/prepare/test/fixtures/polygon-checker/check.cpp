// A checker with testlib's ARGV and EXIT-CODE convention but none of its
// header: `packages/prepare`'s own tests must compile on any machine with a
// g++, including a CI runner with no `~/.cache/testlib` and no network.
// 0 = accepted, 1 = wrong answer.
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
  if (argc < 4) return 3;
  std::ifstream out(argv[2]);
  std::ifstream ans(argv[3]);
  long long got = 0, want = 0;
  if (!(out >> got)) {
    std::cerr << "no integer in the output\n";
    return 1;
  }
  ans >> want;
  if (got != want) {
    std::cerr << "expected " << want << ", got " << got << "\n";
    return 1;
  }
  return 0;
}
