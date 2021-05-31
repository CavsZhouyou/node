'use strict';

const {
  MathFloor,
  NumberIsInteger,
} = primordials;

const { ERR_INVALID_ARG_VALUE } = require('internal/errors').codes;

/**
 * highWaterMark key 兼容 duplex 情况
 *
 * @param {*} options
 * @param {*} isDuplex
 * @param {*} duplexKey
 * @return {*} 
 */
function highWaterMarkFrom(options, isDuplex, duplexKey) {
  return options.highWaterMark != null ? options.highWaterMark :
    isDuplex ? options[duplexKey] : null;
}

/**
 * 获取默认的 highWaterMark 值，如果是 objectMode，则返回 object 的个数
 *
 * @param {*} objectMode
 * @return {*} 
 */
function getDefaultHighWaterMark(objectMode) {
  return objectMode ? 16 : 16 * 1024;
}

/**
 * 计算 highWaterMark 值
 *
 * @param {*} state
 * @param {*} options
 * @param {*} duplexKey
 * @param {*} isDuplex
 * @return {*} 
 */
function getHighWaterMark(state, options, duplexKey, isDuplex) {
  // 获取 options 里的 highWaterMark 值
  const hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
  if (hwm != null) {
    // options 里的 highWaterMark 值合法性检查
    if (!NumberIsInteger(hwm) || hwm < 0) {
      const name = isDuplex ? `options.${duplexKey}` : 'options.highWaterMark';
      throw new ERR_INVALID_ARG_VALUE(name, hwm);
    }
    // 向下取整
    return MathFloor(hwm);
  }

  // Default value
  return getDefaultHighWaterMark(state.objectMode);
}

module.exports = {
  getHighWaterMark,
  getDefaultHighWaterMark
};
