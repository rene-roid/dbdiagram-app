export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** An alignment line: vertical at x = `at` (axis 'x') or horizontal at y = `at` (axis 'y'), running from..to. */
export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

export interface SnapOptions {
  /** grid size, or null for no grid */
  grid: number | null
  /** line up edges and centres with the other boxes */
  align: boolean
  /** how close (in diagram units) an edge has to be before it snaps */
  threshold: number
}

// start, centre and end of a box along one axis
const anchors = (start: number, size: number) => [start, start + size / 2, start + size]

function snapAxis(start: number, size: number, others: [number, number][], o: SnapOptions) {
  const mine = anchors(start, size)
  let best = Infinity
  let at: number | null = null
  if (o.align) {
    for (const [s, z] of others) {
      const theirs = anchors(s, z)
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          // centres line up with centres; edges with either edge of the other box
          if ((i === 1) !== (j === 1)) continue
          const d = theirs[j] - mine[i]
          if (Math.abs(d) <= o.threshold && Math.abs(d) < Math.abs(best)) {
            best = d
            at = theirs[j]
          }
        }
      }
    }
  }
  if (at !== null) return { d: best, at }
  if (o.grid) return { d: Math.round(start / o.grid) * o.grid - start, at: null }
  return { d: 0, at: null }
}

/** Where to move `box` (the bounding box of the dragged tables) so it snaps, and the guides to show for it. */
export function snapMove(box: Box, others: Box[], o: SnapOptions): { dx: number; dy: number; guides: Guide[] } {
  const sx = snapAxis(box.x, box.w, others.map((b) => [b.x, b.w]), o)
  const sy = snapAxis(box.y, box.h, others.map((b) => [b.y, b.h]), o)
  const moved = { x: box.x + sx.d, y: box.y + sy.d, w: box.w, h: box.h }
  const guides: Guide[] = []
  const touches = (s: number, z: number, at: number) => anchors(s, z).some((v) => Math.abs(v - at) < 0.5)
  if (sx.at !== null) {
    let from = moved.y
    let to = moved.y + moved.h
    for (const b of others) {
      if (!touches(b.x, b.w, sx.at)) continue
      from = Math.min(from, b.y)
      to = Math.max(to, b.y + b.h)
    }
    guides.push({ axis: 'x', at: sx.at, from, to })
  }
  if (sy.at !== null) {
    let from = moved.x
    let to = moved.x + moved.w
    for (const b of others) {
      if (!touches(b.y, b.h, sy.at)) continue
      from = Math.min(from, b.x)
      to = Math.max(to, b.x + b.w)
    }
    guides.push({ axis: 'y', at: sy.at, from, to })
  }
  return { dx: sx.d, dy: sy.d, guides }
}
