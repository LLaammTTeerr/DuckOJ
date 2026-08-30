/**
 * The golden pairs: the four relationships this feature exists to tell apart.
 *
 * Every number here is a claim about the ALGORITHM, not about a threshold
 * anyone typed. The default threshold is 0.6 (D77), so the assertions are
 * written as "comfortably above it" and "comfortably below it" — a pair that
 * lands at 0.61 would be a coin toss dressed up as a test.
 */
import { describe, expect, it } from 'vitest';
import { fingerprint, matchedSpans, similarity } from '../src/index.js';

/** The original: a two-function C++ solution of the shape a contest gets. */
const ORIGINAL = `
#include <bits/stdc++.h>
using namespace std;

long long gcd_of(long long a, long long b) {
  while (b != 0) {
    long long t = a % b;
    a = b;
    b = t;
  }
  return a;
}

int solve(int n, vector<int>& values) {
  long long best = 0;
  for (int i = 0; i < n; i++) {
    for (int j = i + 1; j < n; j++) {
      best = max(best, gcd_of(values[i], values[j]));
    }
  }
  return (int)best;
}

int main() {
  int n;
  scanf("%d", &n);
  vector<int> values(n);
  for (int i = 0; i < n; i++) scanf("%d", &values[i]);
  printf("%d\\n", solve(n, values));
  return 0;
}
`;

/** The same program with every name changed and the comments rewritten. */
const RENAMED = `
#include <bits/stdc++.h>
using namespace std;

// tim uoc chung lon nhat
long long ucln(long long x, long long y) {
  while (y != 0) {
    long long tam = x % y;
    x = y;
    y = tam;
  }
  return x;
}

int giaiBai(int soLuong, vector<int>& mang) {
  long long ketQua = 0;
  for (int idx = 0; idx < soLuong; idx++) {
    for (int jdx = idx + 1; jdx < soLuong; jdx++) {
      ketQua = max(ketQua, ucln(mang[idx], mang[jdx]));
    }
  }
  return (int)ketQua;
}

int main() {
  int soLuong;
  scanf("%d", &soLuong);
  vector<int> mang(soLuong);
  for (int idx = 0; idx < soLuong; idx++) scanf("%d", &mang[idx]);
  printf("%d\\n", giaiBai(soLuong, mang));
  return 0;
}
`;

/** The same program with its two helpers swapped and reindented. */
const REORDERED = `
#include <bits/stdc++.h>
using namespace std;
int gcd_of(long long, long long);
int solve(int n, vector<int>& values)
{
    long long best = 0;
    for (int i = 0; i < n; i++)
    {
        for (int j = i + 1; j < n; j++)
        {
            best = max(best, gcd_of(values[i], values[j]));
        }
    }
    return (int)best;
}
long long gcd_of(long long a, long long b)
{
    while (b != 0)
    {
        long long t = a % b;
        a = b;
        b = t;
    }
    return a;
}
int main()
{
    int n;
    scanf("%d", &n);
    vector<int> values(n);
    for (int i = 0; i < n; i++) scanf("%d", &values[i]);
    printf("%d\\n", solve(n, values));
    return 0;
}
`;

/** A different problem, solved by a different person. */
const UNRELATED = `
#include <iostream>
#include <string>
#include <map>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  string line;
  map<string, int> counts;
  while (getline(cin, line)) {
    if (line.empty()) continue;
    counts[line] += 1;
  }
  string bestWord;
  int bestCount = -1;
  for (const auto& entry : counts) {
    if (entry.second > bestCount) {
      bestCount = entry.second;
      bestWord = entry.first;
    }
  }
  cout << bestWord << ' ' << bestCount << '\\n';
  return 0;
}
`;

/** The renamed copy padded with a hundred lines of dead code. */
const PADDED = `${RENAMED}
namespace unused_helpers {
${Array.from({ length: 40 }, (_, i) => `  int helper_${String(i)}(int a) { return a * ${String(i)} + ${String(i * 3)}; }`).join('\n')}
}
`;

describe('golden pairs', () => {
  it('identical sources score 1', () => {
    const score = similarity(ORIGINAL, ORIGINAL, 'cpp');
    expect(score.jaccard).toBe(1);
    expect(score.containment).toBe(1);
  });

  it('renamed identifiers stay well above the 0.6 threshold', () => {
    const score = similarity(ORIGINAL, RENAMED, 'cpp');
    expect(score.containment).toBeGreaterThan(0.9);
    expect(score.jaccard).toBeGreaterThan(0.9);
  });

  it('reordered functions and reindentation stay above the threshold', () => {
    const score = similarity(ORIGINAL, REORDERED, 'cpp');
    expect(score.containment).toBeGreaterThan(0.7);
  });

  it('a copy padded with dead code is caught by containment', () => {
    const score = similarity(ORIGINAL, PADDED, 'cpp');
    expect(score.containment).toBeGreaterThan(0.85);
    // Jaccard is the number that falls, and that difference is the whole
    // reason both are reported: 0.9/0.5 says "buried in a longer file".
    expect(score.jaccard).toBeLessThan(score.containment);
  });

  it('unrelated solutions stay far below the threshold', () => {
    const score = similarity(ORIGINAL, UNRELATED, 'cpp');
    expect(score.containment).toBeLessThan(0.3);
    expect(score.jaccard).toBeLessThan(0.3);
  });

  it('is symmetric', () => {
    const forward = similarity(ORIGINAL, RENAMED, 'cpp');
    const backward = similarity(RENAMED, ORIGINAL, 'cpp');
    expect(backward.jaccard).toBeCloseTo(forward.jaccard, 12);
    expect(backward.containment).toBeCloseTo(forward.containment, 12);
  });

  it('scores zero rather than one for two sources too short to fingerprint', () => {
    // `0/0` is not 1: two files with no k-gram between them are two files
    // this algorithm has nothing to say about.
    expect(similarity('a;', 'a;', 'cpp').containment).toBe(0);
    expect(similarity('', '', 'cpp').jaccard).toBe(0);
  });

  it('every score is a real number in [0, 1]', () => {
    for (const [left, right] of [
      [ORIGINAL, RENAMED],
      [ORIGINAL, UNRELATED],
      [PADDED, UNRELATED],
      [REORDERED, RENAMED],
    ] as const) {
      const score = similarity(left, right, 'cpp');
      expect(Number.isFinite(score.jaccard)).toBe(true);
      expect(score.jaccard).toBeGreaterThanOrEqual(0);
      expect(score.containment).toBeLessThanOrEqual(1);
      // Containment can never be below Jaccard — the union is never smaller
      // than the smaller set. The reporting rule depends on this.
      expect(score.containment).toBeGreaterThanOrEqual(score.jaccard);
    }
  });
});

describe('golden pairs — python and java', () => {
  const PY_ORIGINAL = `
import sys

def read_ints():
    return list(map(int, sys.stdin.readline().split()))

def main():
    n = int(sys.stdin.readline())
    total = 0
    for _ in range(n):
        a, b = read_ints()
        if a > b:
            total += a - b
        else:
            total += b - a
    print(total)

main()
`;
  const PY_RENAMED = `
import sys

# doc cac so nguyen
def docSo():
    return list(map(int, sys.stdin.readline().split()))

def chuongTrinh():
    soLuong = int(sys.stdin.readline())
    tong = 0
    for _ in range(soLuong):
        x, y = docSo()
        if x > y:
            tong += x - y
        else:
            tong += y - x
    print(tong)

chuongTrinh()
`;
  const PY_UNRELATED = `
n, m = map(int, input().split())
grid = [input() for _ in range(n)]
best = 0
for row in grid:
    if row.count('#') > best:
        best = row.count('#')
print(best)
`;

  it('separates a renamed python copy from an unrelated one', () => {
    expect(similarity(PY_ORIGINAL, PY_RENAMED, 'python').containment).toBeGreaterThan(0.9);
    expect(similarity(PY_ORIGINAL, PY_UNRELATED, 'python').containment).toBeLessThan(0.3);
  });

  it('separates a renamed java copy from an unrelated one', () => {
    const JAVA_ORIGINAL = `
import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    int n = sc.nextInt();
    long total = 0;
    for (int i = 0; i < n; i++) {
      total += sc.nextLong();
    }
    System.out.println(total);
  }
}
`;
    const JAVA_RENAMED = `
import java.util.*;
public class Main {
  public static void main(String[] argv) {
    Scanner doc = new Scanner(System.in);
    int soLuong = doc.nextInt();
    long tong = 0;
    for (int idx = 0; idx < soLuong; idx++) {
      tong += doc.nextLong();
    }
    System.out.println(tong);
  }
}
`;
    const JAVA_UNRELATED = `
public class Main {
  static boolean isPrime(int x) {
    if (x < 2) return false;
    for (int d = 2; d * d <= x; d++) if (x % d == 0) return false;
    return true;
  }
  public static void main(String[] args) {
    for (int i = 0; i < 100; i++) if (isPrime(i)) System.out.print(i + " ");
  }
}
`;
    expect(similarity(JAVA_ORIGINAL, JAVA_RENAMED, 'java').containment).toBeGreaterThan(0.9);
    expect(similarity(JAVA_ORIGINAL, JAVA_UNRELATED, 'java').containment).toBeLessThan(0.35);
  });
});

describe('matched spans', () => {
  it('point at real code in each source, and cover the shared function', () => {
    const a = fingerprint(ORIGINAL, 'cpp');
    const b = fingerprint(RENAMED, 'cpp');
    const spans = matchedSpans(a, b);
    expect(spans.a.length).toBeGreaterThan(0);
    expect(spans.b.length).toBeGreaterThan(0);
    for (const span of spans.a) {
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.end).toBeLessThanOrEqual(ORIGINAL.length);
    }
    // Sorted and disjoint after merging, or the web would paint overlapping
    // <mark>s and produce invalid nesting.
    for (let i = 1; i < spans.a.length; i += 1) {
      expect(spans.a[i]!.start).toBeGreaterThan(spans.a[i - 1]!.end);
    }
    const highlighted = spans.a.map((span) => ORIGINAL.slice(span.start, span.end)).join('\n');
    expect(highlighted).toContain('while');
  });

  it('finds nothing between unrelated sources', () => {
    const spans = matchedSpans(fingerprint(ORIGINAL, 'cpp'), fingerprint(UNRELATED, 'cpp'));
    const covered = spans.a.reduce((sum, span) => sum + (span.end - span.start), 0);
    expect(covered).toBeLessThan(ORIGINAL.length * 0.3);
  });
});
