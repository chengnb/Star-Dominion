const { CELL_SIZE } = require('./constants');

class SpatialGrid {
  constructor() {
    this.cellSize = CELL_SIZE;
    this.cells = new Map(); // "col,row" → Set<id>
  }

  _key(col, row) {
    return `${col},${row}`;
  }

  _cellIndex(x, y) {
    return {
      col: Math.floor(x / this.cellSize),
      row: Math.floor(y / this.cellSize),
    };
  }

  insert(id, x, y) {
    const { col, row } = this._cellIndex(x, y);
    const key = this._key(col, row);
    if (!this.cells.has(key)) this.cells.set(key, new Set());
    this.cells.get(key).add(id);
  }

  remove(id, x, y) {
    const { col, row } = this._cellIndex(x, y);
    const key = this._key(col, row);
    const cell = this.cells.get(key);
    if (cell) {
      cell.delete(id);
      if (cell.size === 0) this.cells.delete(key);
    }
  }

  move(id, oldX, oldY, newX, newY) {
    const oldIdx = this._cellIndex(oldX, oldY);
    const newIdx = this._cellIndex(newX, newY);
    if (oldIdx.col === newIdx.col && oldIdx.row === newIdx.row) return;

    const oldKey = this._key(oldIdx.col, oldIdx.row);
    const newKey = this._key(newIdx.col, newIdx.row);

    const oldCell = this.cells.get(oldKey);
    if (oldCell) {
      oldCell.delete(id);
      if (oldCell.size === 0) this.cells.delete(oldKey);
    }

    if (!this.cells.has(newKey)) this.cells.set(newKey, new Set());
    this.cells.get(newKey).add(id);
  }

  /** Return all entity IDs in cells that overlap with the given circle */
  query(x, y, radius) {
    const result = new Set();
    const minCol = Math.floor((x - radius) / this.cellSize);
    const maxCol = Math.floor((x + radius) / this.cellSize);
    const minRow = Math.floor((y - radius) / this.cellSize);
    const maxRow = Math.floor((y + radius) / this.cellSize);

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = this.cells.get(this._key(col, row));
        if (cell) {
          for (const id of cell) {
            result.add(id);
          }
        }
      }
    }
    return result;
  }
}

module.exports = SpatialGrid;
