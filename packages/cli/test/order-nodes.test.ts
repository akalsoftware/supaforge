/**
 * orderNodes gives the order the scan-the-remainder sort it replaced gave,
 * on random fix sets with and without cycles, and does so in linear-ish time.
 *
 * `reference` is that sort, kept verbatim: each step filtered the remaining
 * statements for the ready ones, which made a large data fix set quadratic.
 */
import { describe, it, expect } from 'vitest'
import { orderNodes, PHASE, type Node } from '../src/sql-deps.js'

const DROP_PHASES = new Set<number>([PHASE.DROP_DEPENDANT, PHASE.DROP_TABLE, PHASE.DROP_ROUTINE, PHASE.DROP_BASE, PHASE.DROP_EXTENSION])

function reference(nodes: Node[]): number[] {
  const isSatisfied = (after: Set<number>, done: Set<number>) => [...after].every(d => done.has(d))
  const nextReady = (remaining: number[], done: Set<number>): number => {
    const ready = remaining.filter(i => isSatisfied(nodes[i].after, done))
    const first = (from: number[], key: (n: Node) => number) =>
      from.reduce<number | undefined>((best, i) => best === undefined || key(nodes[i]) < key(nodes[best]) ? i : best, undefined)
    const head = first(ready.filter(i => nodes[i].rank !== undefined), n => n.rank as number)
    const free = first(ready.filter(i => nodes[i].rank === undefined), n => n.phase)
    if (head === undefined || free === undefined) return head ?? free ?? remaining[0]
    const sequence = Math.min(...remaining
      .filter(i => nodes[i].rank !== undefined && !DROP_PHASES.has(nodes[i].phase))
      .map(i => nodes[i].phase))
    return nodes[free].phase < sequence ? free : head
  }
  const done = new Set<number>()
  let remaining = nodes.map((_, i) => i)
  const order: number[] = []
  while (remaining.length > 0) {
    const next = nextReady(remaining, done)
    order.push(next)
    done.add(next)
    remaining = remaining.filter(i => i !== next)
  }
  return order
}

/** A small deterministic generator, so a failure can be replayed by seed. */
function random(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

const PHASES = Object.values(PHASE) as number[]

function randomNodes(seed: number): Node[] {
  const rnd = random(seed)
  const n = 1 + Math.floor(rnd() * 30)
  const ranks = Array.from({ length: n }, (_, i) => i).sort(() => rnd() - 0.5)
  const cyclic = rnd() < 0.3
  return Array.from({ length: n }, (_, i) => {
    const after = new Set<number>()
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      // Edges only to earlier nodes cannot make a cycle; some sets allow later ones too.
      if ((j < i || cyclic) && rnd() < 0.12) after.add(j)
    }
    return {
      phase: PHASES[Math.floor(rnd() * PHASES.length)],
      rank: rnd() < 0.5 ? ranks[i] : undefined,
      after,
    }
  })
}

describe('orderNodes', () => {
  it('orders random fix sets as the sort it replaced did, cycles included', () => {
    for (let seed = 1; seed <= 5000; seed++) {
      const nodes = randomNodes(seed)
      expect(orderNodes(nodes), `seed ${seed}`).toEqual(reference(nodes))
    }
  })

  it('orders 400,000 data fixes behind their table in moments', () => {
    const n = 400_000
    const nodes: Node[] = [{ phase: PHASE.CREATE_TABLE, rank: 0, after: new Set() }]
    for (let i = 1; i < n; i++) nodes.push({ phase: 100, rank: i, after: new Set([0]) })
    const started = performance.now()
    const order = orderNodes(nodes)
    expect(performance.now() - started).toBeLessThan(3000)
    expect(order[0]).toBe(0)
    expect(order.length).toBe(n)
  })
})
