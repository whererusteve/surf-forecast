"""
Travel time from winter road access to every zone (estimates, not route advice).

Skinning uses the Munter method, the standard ski-touring planning formula:
  1 unit per km of distance + 1 unit per 100 m of climbing,
  4 units per hour uphill (average touring party), 10 units per hour skiing down.
Sleds travel only along legal over-snow routes, at a conservative average speed,
and then the party skins the rest.

The route search runs on a ~90 m grid and prefers low-angle terrain and drainages:
steep cells, open water and cells exposed to avalanche paths cost extra. It reports
whether the cheapest approach still crosses or runs under avalanche terrain.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import dijkstra

from terrain import DIRS8

MUNTER_UP = 4.0       # units per hour uphill
MUNTER_DOWN = 10.0    # units per hour skiing downhill
SLED_KMH = 20.0       # average incl. loading, unloading, slow or untracked roads
MULTI_DAY_H = 5.0     # one-way time beyond which we flag "overnight / multi-day"


def terrain_factor(steep35, steep45, tree, water, exposed):
    """Cost multiplier per cell: how much slower than open, moderate terrain."""
    return (1.0 + 2.0 * steep35 + 12.0 * steep45 + 0.25 * tree + 3.0 * water
            + 0.3 * exposed.astype(np.float32))


class Router:
    def __init__(self, zc, factor, dy, dx_row, sled_cells=None):
        Hc, Wc = zc.shape
        self.shape = (Hc, Wc)
        self.N = Hc * Wc
        self.zc = zc.ravel()
        idx = np.arange(self.N).reshape(Hc, Wc)
        valid = ~np.isnan(zc)
        f = factor.ravel()
        src_l, dst_l, w_l = [], [], []
        for di, dj in DIRS8:
            a, b = _pairs(idx, di, dj)
            rows = (a // Wc)
            dist_m = np.hypot(di * dy, dj * dx_row[rows])
            a, b, dist_m = a.ravel(), b.ravel(), dist_m.ravel()
            ok = valid.ravel()[a] & valid.ravel()[b]
            a, b, dist_m = a[ok], b[ok], dist_m[ok]
            dz = self.zc[b] - self.zc[a]
            units = dist_m / 1000 + np.abs(dz) / 100
            hours = np.where(dz > 0, units / MUNTER_UP, units / MUNTER_DOWN)
            w = hours * 0.5 * (f[a] + f[b])
            src_l.append(a); dst_l.append(b); w_l.append(w)
        self.n_skin_edges = sum(len(x) for x in src_l)
        # Sled layer: one extra node per sled-route cell
        self.sled_node = None
        if sled_cells is not None and sled_cells.any():
            cells = np.nonzero(sled_cells.ravel())[0]
            self.sled_node = np.full(self.N, -1, np.int64)
            self.sled_node[cells] = self.N + np.arange(cells.size)
            self.sled_cells = cells
            for di, dj in DIRS8:
                a, b = _pairs(idx, di, dj)
                rows = a // Wc
                dist_m = np.hypot(di * dy, dj * dx_row[rows]).ravel()
                a, b = a.ravel(), b.ravel()
                ok = (self.sled_node[a] >= 0) & (self.sled_node[b] >= 0)
                src_l.append(self.sled_node[a[ok]]); dst_l.append(self.sled_node[b[ok]])
                w_l.append(dist_m[ok] / 1000 / SLED_KMH)
            # park the sled and start skinning (one way only)
            src_l.append(self.sled_node[cells]); dst_l.append(cells); w_l.append(np.full(cells.size, 1e-4))
        self.n_nodes = self.N + (0 if self.sled_node is None else self.sled_cells.size)
        self.S = self.n_nodes          # super-source node
        self._edges = (np.concatenate(src_l), np.concatenate(dst_l), np.concatenate(w_l))

    def run(self, starts, use_sled=False):
        """starts: list of (skin_cell_index, offset_hours). Returns (dist, pred)."""
        src, dst, w = self._edges
        if not use_sled and self.sled_node is not None:
            keep = (src < self.N) & (dst < self.N)
            src, dst, w = src[keep], dst[keep], w[keep]
        s_dst, s_w = [], []
        for cell, off in starts:
            s_dst.append(cell); s_w.append(max(off, 1e-4))
            if use_sled and self.sled_node is not None and self.sled_node[cell] >= 0:
                s_dst.append(self.sled_node[cell]); s_w.append(max(off, 1e-4))
        s_dst = np.array(s_dst, np.int64)
        s_w = np.array(s_w)
        # keep the cheapest edge per start node
        order = np.lexsort((s_w, s_dst))
        s_dst, s_w = s_dst[order], s_w[order]
        first = np.r_[True, s_dst[1:] != s_dst[:-1]]
        s_dst, s_w = s_dst[first], s_w[first]
        n = self.n_nodes + 1
        g = sparse.csr_matrix((np.r_[w, s_w], (np.r_[src, np.full(s_dst.size, self.S)], np.r_[dst, s_dst])),
                              shape=(n, n))
        dist, pred = dijkstra(g, directed=True, indices=self.S, return_predecessors=True)
        return dist, pred

    def trace(self, pred, target, dy, dx_row, exposed_flat, zone_of_cell, zone_id):
        """Walk back from target to the start. Returns leg summary."""
        Wc = self.shape[1]
        node = target
        skin_km = sled_km = climb = 0.0
        exposed_run = max_exposed_run = 0
        exposed_cells = 0
        steps = 0
        while True:
            p = pred[node]
            if p < 0 or p == self.S:
                break
            a_cell = p if p < self.N else self.sled_cells[p - self.N]
            b_cell = node if node < self.N else self.sled_cells[node - self.N]
            ra, ca = divmod(int(a_cell), Wc)
            rb, cb = divmod(int(b_cell), Wc)
            d_km = math.hypot((rb - ra) * dy, (cb - ca) * dx_row[ra]) / 1000
            if p >= self.N and node >= self.N:
                sled_km += d_km
            elif node < self.N and p < self.N:
                skin_km += d_km
                dz = self.zc[b_cell] - self.zc[a_cell]
                if dz > 0:
                    climb += dz
                if exposed_flat[b_cell] and zone_of_cell[b_cell] != zone_id:
                    exposed_cells += 1
                    exposed_run += 1
                    max_exposed_run = max(max_exposed_run, exposed_run)
                else:
                    exposed_run = 0
            node = p
            steps += 1
            if steps > 100_000:
                break
        start = int(node if node < self.N else self.sled_cells[node - self.N])
        return dict(skin_km=skin_km, sled_km=sled_km, climb=climb, start=start,
                    exposed_cells=exposed_cells, max_exposed_run=max_exposed_run)


def _pairs(idx, di, dj):
    """Grid indices (a, b) where b is the neighbour of a at offset (di, dj)."""
    H, W = idx.shape
    a = idx[max(0, -di):H - max(0, di), max(0, -dj):W - max(0, dj)]
    b = idx[max(0, di):H + min(0, di), max(0, dj):W + min(0, dj)]
    return a, b


def skin_hours(km, climb_m, descent_m=0.0):
    """Munter time for a simple leg (used in tests and the app's pace setting)."""
    return (km + climb_m / 100) / MUNTER_UP + (descent_m / 100) / MUNTER_DOWN
