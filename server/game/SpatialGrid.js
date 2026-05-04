const { WORLD_WIDTH, WORLD_HEIGHT, CELL_SIZE } = require('./constants');

class SpatialGrid {
  constructor() {
    this.cols = Math.ceil(WORLD_WIDTH / CELL_SIZE);
    this.rows = Math.ceil(WORLD_HEIGHT / CELL_SIZE);
    this.cells = new Array(this.cols * this.rows).fill(null).map(() => new Set());
  }

  _cellIndex(x, y) {
    const col = Math.floor(x / CELL_SIZE);
    const row = Math.floor(y / CELL_SIZE);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  _clampCell(col, row) {
    return {
      col: Math.max(0, Math.min(this.cols - 1, col)),
      row: Math.max(0, Math.min(this.rows - 1, row)),
    };
  }

  insert(id, x, y) {
    const idx = this._cellIndex(x, y);
    if (idx >= 0) this.cells[idx].add(id);
  }

  remove(id, x, y) {
    const idx = this._cellIndex(x, y);
    if (idx >= 0) this.cells[idx].delete(id);
  }

  move(id, oldX, oldY, newX, newY) {
    const oldIdx = this._cellIndex(oldX, oldY);
    const newIdx = this._cellIndex(newX, newY);
    if (oldIdx === newIdx) return;
    if (oldIdx >= 0) this.cells[oldIdx].delete(id);
    if (newIdx >= 0) this.cells[newIdx].add(id);
  }

  /** Return all entity IDs in cells that overlap with the given circle */
  query(x, y, radius) {
    const result = new Set();
    const minCol = Math.floor((x - radius) / CELL_SIZE);
    const maxCol = Math.floor((x + radius) / CELL_SIZE);
    const minRow = Math.floor((y - radius) / CELL_SIZE);
    const maxRow = Math.floor((y + radius) / CELL_SIZE);

    const { col: c0, row: r0 } = this._clampCell(minCol, minRow);
    const { col: c1, row: r1 } = this._clampCell(maxCol, maxRow);

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const idx = row * this.cols + col;
        for (const id of this.cells[idx]) {
          result.add(id);
        }
      }
    }
    return result;
  }
}

module.exports = SpatialGrid;
