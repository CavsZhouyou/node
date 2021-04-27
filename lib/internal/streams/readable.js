// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const {
  ArrayPrototypeIndexOf,
  NumberIsInteger,
  NumberIsNaN,
  NumberParseInt,
  ObjectDefineProperties,
  ObjectKeys,
  ObjectSetPrototypeOf,
  Promise,
  SafeSet,
  SymbolAsyncIterator,
  Symbol,
} = primordials;

module.exports = Readable;
Readable.ReadableState = ReadableState;

const EE = require('events');
const { Stream, prependListener } = require('internal/streams/legacy');
const { Buffer } = require('buffer');

const {
  addAbortSignalNoValidate,
} = require('internal/streams/add-abort-signal');

let debug = require('internal/util/debuglog').debuglog('stream', (fn) => {
  debug = fn;
});
const BufferList = require('internal/streams/buffer_list');
const destroyImpl = require('internal/streams/destroy');
const {
  getHighWaterMark,
  getDefaultHighWaterMark,
} = require('internal/streams/state');

const {
  ERR_INVALID_ARG_TYPE,
  ERR_STREAM_PUSH_AFTER_EOF,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_STREAM_UNSHIFT_AFTER_END_EVENT,
} = require('internal/errors').codes;

const kPaused = Symbol('kPaused');

// Lazy loaded to improve the startup performance.
let StringDecoder;
let from;

ObjectSetPrototypeOf(Readable.prototype, Stream.prototype);
ObjectSetPrototypeOf(Readable, Stream);
const nop = () => {};

const { errorOrDestroy } = destroyImpl;

/**
 * Readable 內部状态机(核心)
 *
 * @param {*} options
 * @param {*} stream
 * @param {*} isDuplex
 */
function ReadableState(options, stream, isDuplex) {
  // 判断是否为 isDuplex 类型
  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  if (typeof isDuplex !== 'boolean') isDuplex = stream instanceof Stream.Duplex;

  // 是否为 objectMode 模式
  // Object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away.
  this.objectMode = !!(options && options.objectMode);

  // duplex 的 objectMode 判断
  if (isDuplex)
    this.objectMode =
      this.objectMode || !!(options && options.readableObjectMode);

  // 获取 highWaterMark 值，highWaterMark 为缓存的水位标识
  // The point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  this.highWaterMark = options
    ? getHighWaterMark(this, options, 'readableHighWaterMark', isDuplex)
    : getDefaultHighWaterMark(false);

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift().
  // 使用链表来作为缓存
  this.buffer = new BufferList();
  // 缓存的长度
  this.length = 0;
  // pipes 流列表
  this.pipes = [];
  // 流动状态
  this.flowing = null;
  // 标识数据源是否读取完毕，为 true 表示数据源已读取完毕
  // 此时 Readable 中可能还有数据，不能再向缓冲池中 push() 数据
  this.ended = false;
  // 标识数据源读取完毕事件是否已触发，为 true 表示 end 事件已触发
  // 此时 Readable 中数据已读取完毕，不能再向缓冲池中 push() 或 unshift()　数据
  this.endEmitted = false;
  // 标识是否正在调用 _read() 方法从底层数据源获取数据
  this.reading = false;

  // Stream is still being constructed and cannot be
  // destroyed until construction finished or failed.
  // Async construction is opt in, therefore we start as
  // constructed.
  // 标识 stream 是否已经初始化完成
  this.constructed = true;

  // A flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.
  // 标识是否能立即触发 readable 或 data 事件
  this.sync = true;

  // Whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  // 标识是否需要触发 readable 事件
  this.needReadable = false;
  // 标识 readable 事件是否已经被触发
  this.emittedReadable = false;
  // 标识是否有 readable 事件的监听者
  this.readableListening = false;
  // 判断是否有已在队列中的 resume 任务
  this.resumeScheduled = false;
  // TODO: 不清楚
  this[kPaused] = null;

  // True if the error was already emitted and should not be thrown again.
  // 标识是否已经抛出过错误
  this.errorEmitted = false;

  // Should close be emitted on destroy. Defaults to true.
  // 标识 destroy 时是否需要触发 close 事件
  this.emitClose = !options || options.emitClose !== false;

  // Should .destroy() be called after 'end' (and potentially 'finish').
  // 标识 destroy 事件是否在 end 事件后自动触发
  this.autoDestroy = !options || options.autoDestroy !== false;

  // Has it been destroyed.
  // 标识是否已经被 destory 了
  this.destroyed = false;

  // Indicates whether the stream has errored. When true no further
  // _read calls, 'data' or 'readable' events should occur. This is needed
  // since when autoDestroy is disabled we need a way to tell whether the
  // stream has failed.
  // 标识 stream 是否发生过错误
  this.errored = null;

  // Indicates whether the stream has finished destroying.
  // 标识 stream 是否已经完成了 destroy
  this.closed = false;

  // True if close has been emitted or would have been emitted
  // depending on emitClose.
  // 标识 close 事件是否已被触发
  this.closeEmitted = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  // 设置默认的 encoding
  this.defaultEncoding = (options && options.defaultEncoding) || 'utf8';

  // pipe 时，需要监听 drain 事件的 writers 
  // Ref the piped dest which we need a drain event on it
  // type: null | Writable | Set<Writable>.
  this.awaitDrainWriters = null;
  this.multiAwaitDrain = false;

  // If true, a maybeReadMore has been scheduled.
  // 标识是否应该读取更多底层数据源的数据
  this.readingMore = false;

  // 指定解码器和 encoding 格式
  this.decoder = null;
  this.encoding = null;
  if (options && options.encoding) {
    if (!StringDecoder) StringDecoder = require('string_decoder').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

/**
 * 构造函数
 *
 * @param {*} options
 * @return {*}
 */
function Readable(options) {
  /*
   * 参数判断
   */

  // 防止直接调用 Readable 方法的情况
  if (!(this instanceof Readable)) return new Readable(options);

  // 判断是否为 Duplex，Duplex 里 readable options 的 key 值可能不同
  // Checking for a Stream.Duplex instance is faster here instead of inside
  // the ReadableState constructor, at least with V8 6.5.
  const isDuplex = this instanceof Stream.Duplex;

  // 初始化 readable 的状态
  this._readableState = new ReadableState(options, this, isDuplex);

  /*
   * 参数赋值
   */
  if (options) {
    // 设置自定义的 _read 方法
    if (typeof options.read === 'function') this._read = options.read;

    // 设置自定义的 _destroy 方法
    if (typeof options.destroy === 'function') this._destroy = options.destroy;

    // 设置自定义的 construct 方法
    if (typeof options.construct === 'function')
      this._construct = options.construct;
    // 添加 abort 错误的监听
    if (options.signal && !isDuplex)
      addAbortSignalNoValidate(options.signal, this);
  }

  // stream 初始化
  Stream.call(this, options);

  // 执行自定义 _construct 方法
  destroyImpl.construct(this, () => {
    if (this._readableState.needReadable) {
      maybeReadMore(this, this._readableState);
    }
  });
}

// 定义默认的 destroy 方法
Readable.prototype.destroy = destroyImpl.destroy;
Readable.prototype._undestroy = destroyImpl.undestroy;
Readable.prototype._destroy = function (err, cb) {
  cb(err);
};

Readable.prototype[EE.captureRejectionSymbol] = function (err) {
  this.destroy(err);
};

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read().
Readable.prototype.unshift = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, true);
};

function readableAddChunk(stream, chunk, encoding, addToFront) {
  debug('readableAddChunk', chunk);
  const state = stream._readableState;

  let err;
  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding = encoding || state.defaultEncoding;
      if (state.encoding !== encoding) {
        if (addToFront && state.encoding) {
          // When unshifting, if state.encoding is set, we have to save
          // the string in the BufferList with the state encoding.
          chunk = Buffer.from(chunk, encoding).toString(state.encoding);
        } else {
          chunk = Buffer.from(chunk, encoding);
          encoding = '';
        }
      }
    } else if (chunk instanceof Buffer) {
      encoding = '';
    } else if (Stream._isUint8Array(chunk)) {
      chunk = Stream._uint8ArrayToBuffer(chunk);
      encoding = '';
    } else if (chunk != null) {
      err = new ERR_INVALID_ARG_TYPE(
        'chunk',
        ['string', 'Buffer', 'Uint8Array'],
        chunk
      );
    }
  }

  if (err) {
    errorOrDestroy(stream, err);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || (chunk && chunk.length > 0)) {
    if (addToFront) {
      if (state.endEmitted)
        errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT());
      else addChunk(stream, state, chunk, true);
    } else if (state.ended) {
      errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
    } else if (state.destroyed || state.errored) {
      return false;
    } else {
      state.reading = false;
      if (state.decoder && !encoding) {
        chunk = state.decoder.write(chunk);
        if (state.objectMode || chunk.length !== 0)
          addChunk(stream, state, chunk, false);
        else maybeReadMore(stream, state);
      } else {
        addChunk(stream, state, chunk, false);
      }
    }
  } else if (!addToFront) {
    state.reading = false;
    maybeReadMore(stream, state);
  }

  // We can push more data if we are below the highWaterMark.
  // Also, if we have no data yet, we can stand some more bytes.
  // This is to work around cases where hwm=0, such as the repl.
  return (
    !state.ended && (state.length < state.highWaterMark || state.length === 0)
  );
}

function addChunk(stream, state, chunk, addToFront) {
  if (
    state.flowing &&
    state.length === 0 &&
    !state.sync &&
    stream.listenerCount('data') > 0
  ) {
    // Use the guard to avoid creating `Set()` repeatedly
    // when we have multiple pipes.
    if (state.multiAwaitDrain) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
    }
    stream.emit('data', chunk);
  } else {
    // Update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) state.buffer.unshift(chunk);
    else state.buffer.push(chunk);

    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

Readable.prototype.isPaused = function () {
  const state = this._readableState;
  return state[kPaused] === true || state.flowing === false;
};

// Backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = require('string_decoder').StringDecoder;
  const decoder = new StringDecoder(enc);
  this._readableState.decoder = decoder;
  // If setEncoding(null), decoder.encoding equals utf8.
  this._readableState.encoding = this._readableState.decoder.encoding;

  const buffer = this._readableState.buffer;
  // Iterate over current buffer to convert already stored Buffers:
  let content = '';
  for (const data of buffer) {
    content += decoder.write(data);
  }
  buffer.clear();
  if (content !== '') buffer.push(content);
  this._readableState.length = content.length;
  return this;
};

/**
 * 取比 n 大的最小的 2^x 的值为新的 highWaterMark 值
 * Don't raise the hwm > 1GB.
 *
 * @param {*} n
 * @return {*} 
 */
const MAX_HWM = 0x40000000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    // TODO(ronag): Throw ERR_VALUE_OUT_OF_RANGE.
    n = MAX_HWM;
  } else {
    // 取比 n 大的最小的 2^x 
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts.
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

/**
 * 根据 n 和 readable 状态判断当前应该读取多少数据
 * This function is designed to be inlinable, so please take care when making
 * changes to the function body.
 *
 * @param {*} n
 * @param {*} state
 * @return {*} 
 */
function howMuchToRead(n, state) {
  // 如果 n 为负数或则 readable 缓存里的数据已经读取完毕，则返回 0
  if (n <= 0 || (state.length === 0 && state.ended)) return 0;
  // 如果为 objectMode 模式，则放回 1 
  if (state.objectMode) return 1;
  // 如果 n 不是数字(n 不传的情况)
  if (NumberIsNaN(n)) {
    // 如果 stream 为 flowing 状态，则返回第一个 buffer 的长度
    // Only flow one buffer at a time.
    if (state.flowing && state.length) return state.buffer.first().length;
    // 否则，则返回缓存数据的长度
    return state.length;
  }
  // 如果 n 小于当前缓存的数据，则直接返回 n
  if (n <= state.length) return n;
  // 如果当前 readable 已经读取完毕底层数据源的数据，则直接返回剩余数据的长度
  return state.ended ? state.length : 0;
}

// You can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  // n 取整
  // Same as parseInt(undefined, 10), however V8 7.3 performance regressed
  // in this scenario, so we are doing it manually.
  if (n === undefined) {
    n = NaN;
  } else if (!NumberIsInteger(n)) {
    n = NumberParseInt(n, 10);
  }
  const state = this._readableState;
  // 记录初始 n 值
  const nOrig = n;

  // 如果每次获取的数据量比当前的 highWaterMark 值高，则重新调整 highWaterMark 值
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);

  // 如果 n 不等于 0，则将 readable 事件的触发标识设置为 false
  if (n !== 0) state.emittedReadable = false;

  // 如果通过 read(0) 来触发 readable 事件，且此时缓存中的数据大于 n 或者 readable 数据已经读取完毕，则直接触发 readable 事件
  // If we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (
    n === 0 &&
    state.needReadable &&
    ((state.highWaterMark !== 0
      ? state.length >= state.highWaterMark
      : state.length > 0) ||
      state.ended)
  ) {
    debug('read: emitReadable', state.length, state.ended);
    // 如果 readable 数据已经读取完毕，则调用 endReadable
    if (state.length === 0 && state.ended) endReadable(this);
    // 否则调用 emitReadable
    else emitReadable(this);
    // 直接返回
    return null;
  }

  // 计算当前应该读取的数据量
  n = howMuchToRead(n, state);

  // 如果 readable 数据已经读取完毕，则触发 endReadable 
  // If we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // 如果我们需要触发 readable 事件，则我们需要调用 _read 方法从缓存中读取数据
  // if we need a readable event, then we need to do some reading.
  let doRead = state.needReadable;
  debug('need readable', doRead);

  // 判读读取后的状态，如果当前缓存数据为 0 或者读取后缓存数据小于 highWaterMark 值，则也需要调用 _read 方法
  // If we currently have less than the highWaterMark, then also read some.
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // 状态判断，某些操作下不需要执行 _read 操作
  // However, if we've ended, then there's no point, if we're already
  // reading, then it's unnecessary, if we're constructing we have to wait,
  // and if we're destroyed or errored, then it's not allowed,
  if (
    state.ended ||
    state.reading ||
    state.destroyed ||
    state.errored ||
    !state.constructed
  ) {
    doRead = false;
    debug('reading, ended or constructing', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // 如果当前没有数据，则也需要触发 readable 事件
    // If the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // 调用 _read 事件来获取数据
    // Call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    // 如果是同步读取底层数据源，则需要重新判断返回给用户的数据量
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  // 从缓存从读取数据
  let ret;
  if (n > 0) ret = fromList(n, state);
  else ret = null;

  // 如果返回数据为空
  if (ret === null) {
    // 则判断是否需要触发 readable 事件
    state.needReadable = state.length <= state.highWaterMark;
    // n 重置为 0
    n = 0;
  } else {
    // 缓存长度更新
    state.length -= n;
    // pipe 更新
    if (state.multiAwaitDrain) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
    }
  }

  // 取完数据后，如果缓存长度为 0
  if (state.length === 0) {
    // 如果缓存中没有数据，且 readable 还可以从底层数据源读取数据，则将 needReadable 设置为 true ，以保证数据更新能够及时得到触发
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // 如果 readable 底层数据已经读取完毕，则触发 endReadable
    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  // 触发 data 事件，返回 ret 数据
  if (ret !== null) this.emit('data', ret);

  // 返回 ret 数据
  return ret;
};

function onEofChunk(stream, state) {
  debug('onEofChunk');
  if (state.ended) return;
  if (state.decoder) {
    const chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  if (state.sync) {
    // If we are sync, wait until next tick to emit the data.
    // Otherwise we risk emitting data in the flow()
    // the readable code triggers during a read() call.
    emitReadable(stream);
  } else {
    // Emit 'readable' now to make sure it gets picked up.
    state.needReadable = false;
    state.emittedReadable = true;
    // We have to emit readable now that we are EOF. Modules
    // in the ecosystem (e.g. dicer) rely on this event being sync.
    emitReadable_(stream);
  }
}

/**
 *
 * readable 事件触发条件判断
 * Don't emit readable right away in sync mode, because this can trigger
 * another read() call => stack overflow.  This way, it might trigger
 * a nextTick recursion warning, but that's not so bad.
 * @param {*} stream
 */
function emitReadable(stream) {
  const state = stream._readableState;
  debug('emitReadable', state.needReadable, state.emittedReadable);
  // 重置是否需要触发 readable 事件的状态为 false
  state.needReadable = false;
  // 如果还没有触发 readable 事件
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    // 将触发 readable 事件的标识设置为 true
    state.emittedReadable = true;
    // 下一个 event-loop 执行 emitReadable_ 
    process.nextTick(emitReadable_, stream);
  }
}

/**
 * 触发 readable 事件
 *
 * @param {*} stream
 */
function emitReadable_(stream) {
  const state = stream._readableState;
  debug('emitReadable_', state.destroyed, state.length, state.ended);
  if (!state.destroyed && !state.errored && (state.length || state.ended)) {
    // 触发 readable 事件
    stream.emit('readable');
    state.emittedReadable = false;
  }

  // 判断是否需要下一个 readable 事件
  // The stream needs another readable event if:
  // 1. It is not flowing, as the flow mechanism will take
  //    care of it.
  // 2. It is not ended.
  // 3. It is below the highWaterMark, so we can schedule
  //    another readable later.
  state.needReadable =
    !state.flowing && !state.ended && state.length <= state.highWaterMark;
  flow(stream);
}

// At this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore && state.constructed) {
    state.readingMore = true;
    process.nextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  // Attempt to read more data if we should.
  //
  // The conditions for reading more data are (one of):
  // - Not enough data buffered (state.length < state.highWaterMark). The loop
  //   is responsible for filling the buffer with enough data if such data
  //   is available. If highWaterMark is 0 and we are not in the flowing mode
  //   we should _not_ attempt to buffer any extra data. We'll get more data
  //   when the stream consumer calls read() instead.
  // - No data in the buffer, and the stream is in flowing mode. In this mode
  //   the loop below is responsible for ensuring read() is called. Failing to
  //   call read here would abort the flow and there's no other mechanism for
  //   continuing the flow if the stream consumer has just subscribed to the
  //   'data' event.
  //
  // In addition to the above conditions to keep reading data, the following
  // conditions prevent the data from being read:
  // - The stream has ended (state.ended).
  // - There is already a pending 'read' operation (state.reading). This is a
  //   case where the stream has called the implementation defined _read()
  //   method, but they are processing the call asynchronously and have _not_
  //   called push() with new data. In this case we skip performing more
  //   read()s. The execution ends in this method again after the _read() ends
  //   up calling push() with more data.
  while (
    !state.reading &&
    !state.ended &&
    (state.length < state.highWaterMark ||
      (state.flowing && state.length === 0))
  ) {
    const len = state.length;
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // Didn't get any data, stop spinning.
      break;
  }
  state.readingMore = false;
}

// Abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  throw new ERR_METHOD_NOT_IMPLEMENTED('_read()');
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  const src = this;
  const state = this._readableState;

  if (state.pipes.length === 1) {
    if (!state.multiAwaitDrain) {
      state.multiAwaitDrain = true;
      state.awaitDrainWriters = new SafeSet(
        state.awaitDrainWriters ? [state.awaitDrainWriters] : []
      );
    }
  }

  state.pipes.push(dest);
  debug('pipe count=%d opts=%j', state.pipes.length, pipeOpts);

  const doEnd =
    (!pipeOpts || pipeOpts.end !== false) &&
    dest !== process.stdout &&
    dest !== process.stderr;

  const endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) process.nextTick(endFn);
  else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable, unpipeInfo) {
    debug('onunpipe');
    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  let ondrain;

  let cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // Cleanup event handlers once the pipe is broken.
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    if (ondrain) {
      dest.removeListener('drain', ondrain);
    }
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // If the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (
      ondrain &&
      state.awaitDrainWriters &&
      (!dest._writableState || dest._writableState.needDrain)
    )
      ondrain();
  }

  function pause() {
    // If the user unpiped during `dest.write()`, it is possible
    // to get stuck in a permanently paused state if that write
    // also returned false.
    // => Check whether `dest` is still a piping destination.
    if (!cleanedUp) {
      if (state.pipes.length === 1 && state.pipes[0] === dest) {
        debug('false write response, pause', 0);
        state.awaitDrainWriters = dest;
        state.multiAwaitDrain = false;
      } else if (state.pipes.length > 1 && state.pipes.includes(dest)) {
        debug('false write response, pause', state.awaitDrainWriters.size);
        state.awaitDrainWriters.add(dest);
      }
      src.pause();
    }
    if (!ondrain) {
      // When the dest drains, it reduces the awaitDrain counter
      // on the source.  This would be more elegant with a .once()
      // handler in flow(), but adding and removing repeatedly is
      // too slow.
      ondrain = pipeOnDrain(src, dest);
      dest.on('drain', ondrain);
    }
  }

  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    const ret = dest.write(chunk);
    debug('dest.write', ret);
    if (ret === false) {
      pause();
    }
  }

  // If the dest has an error, then stop piping into it.
  // However, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EE.listenerCount(dest, 'error') === 0) {
      const s = dest._writableState || dest._readableState;
      if (s && !s.errorEmitted) {
        // User incorrectly emitted 'error' directly on the stream.
        errorOrDestroy(dest, er);
      } else {
        dest.emit('error', er);
      }
    }
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // Tell the dest that it's being piped to.
  dest.emit('pipe', src);

  // Start the flow if it hasn't been started already.

  if (dest.writableNeedDrain === true) {
    if (state.flowing) {
      pause();
    }
  } else if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src, dest) {
  return function pipeOnDrainFunctionResult() {
    const state = src._readableState;

    // `ondrain` will call directly,
    // `this` maybe not a reference to dest,
    // so we use the real dest here.
    if (state.awaitDrainWriters === dest) {
      debug('pipeOnDrain', 1);
      state.awaitDrainWriters = null;
    } else if (state.multiAwaitDrain) {
      debug('pipeOnDrain', state.awaitDrainWriters.size);
      state.awaitDrainWriters.delete(dest);
    }

    if (
      (!state.awaitDrainWriters || state.awaitDrainWriters.size === 0) &&
      EE.listenerCount(src, 'data')
    ) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  const state = this._readableState;
  const unpipeInfo = { hasUnpiped: false };

  // If we're not piping anywhere, then do nothing.
  if (state.pipes.length === 0) return this;

  if (!dest) {
    // remove all.
    const dests = state.pipes;
    state.pipes = [];
    this.pause();

    for (let i = 0; i < dests.length; i++)
      dests[i].emit('unpipe', this, { hasUnpiped: false });
    return this;
  }

  // Try to find the right one.
  const index = ArrayPrototypeIndexOf(state.pipes, dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  if (state.pipes.length === 0) this.pause();

  dest.emit('unpipe', this, unpipeInfo);

  return this;
};

/**
 * 监听事件注册劫持，根据不同的监听事件，更新不同的 readable 状态
 * Set up data events if they are asked for
 * Ensure readable listeners eventually get something.
 *
 * @param {*} ev
 * @param {*} fn
 * @return {*} 
 */
Readable.prototype.on = function (ev, fn) {
  // 注册监听事件
  const res = Stream.prototype.on.call(this, ev, fn);
  const state = this._readableState;

  if (ev === 'data') {
    // TODO: 编译情况判断，判断当前是否有 readable 监听事件
    // Update readableListening so that resume() may be a no-op
    // a few lines down. This is needed to support once('readable').
    state.readableListening = this.listenerCount('readable') > 0;

    // 如果 stream 没有显式的暂停状态，则将 stream 的状态切换为 flowing
    // Try start flowing on next tick if stream isn't explicitly paused.
    if (state.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      debug('on readable', state.length, state.reading);
      if (state.length) {
        emitReadable(this);
      } else if (!state.reading) {
        process.nextTick(nReadingNextTick, this);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.removeListener = function (ev, fn) {
  const res = Stream.prototype.removeListener.call(this, ev, fn);

  if (ev === 'readable') {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    process.nextTick(updateReadableListening, this);
  }

  return res;
};
Readable.prototype.off = Readable.prototype.removeListener;

Readable.prototype.removeAllListeners = function (ev) {
  const res = Stream.prototype.removeAllListeners.apply(this, arguments);

  if (ev === 'readable' || ev === undefined) {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    process.nextTick(updateReadableListening, this);
  }

  return res;
};

function updateReadableListening(self) {
  const state = self._readableState;
  state.readableListening = self.listenerCount('readable') > 0;

  if (state.resumeScheduled && state[kPaused] === false) {
    // Flowing needs to be set to true now, otherwise
    // the upcoming resume will not flow.
    state.flowing = true;

    // Crude way to check if we should resume.
  } else if (self.listenerCount('data') > 0) {
    self.resume();
  } else if (!state.readableListening) {
    state.flowing = null;
  }
}

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

/**
 *
 * 改变 flowing 状态为 true
 * pause() and resume() are remnants of the legacy readable stream API
 * If the user uses them, then switch into old mode.
 * @return {*} 
 */
Readable.prototype.resume = function () {
  const state = this._readableState;
  // 如果 stream 不处于 flowing 状态
  if (!state.flowing) {
    debug('resume');
    // We flow only if there is no one listening
    // for readable, but we still have to call
    // resume().
    // 只有在没有 readable 监听事件的情况下，才将 stream 设置为 flowing 状态
    state.flowing = !state.readableListening;
    resume(this, state);
  }
  // kPaused 状态设置为 false
  state[kPaused] = false;
  return this;
};

/**
 * 判断是否需要执行 resume_ 方法
 *
 * @param {*} stream
 * @param {*} state
 */
function resume(stream, state) {
  // 判断是否有队列中的 resume 任务，如果没有，则将 resume_ 推入下一个 event loop 中
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    process.nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  debug('resume', state.reading);
  // 如果当前没有在读取底层数据源，则调用 read(0) 方法触发 _read() 去获取底层数据源
  if (!state.reading) {
    stream.read(0);
  }

  // 设置入队标识为 false
  state.resumeScheduled = false;
  // 触发 resume 事件
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (this._readableState.flowing !== false) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  this._readableState[kPaused] = true;
  return this;
};

/**
 * stream 自动流动的方法
 *
 * @param {*} stream
 */
function flow(stream) {
  const state = stream._readableState;
  debug('flow', state.flowing);
  // 如果 stream 状态为 flowing，则一直递归调用 stream.read()
  while (state.flowing && stream.read() !== null);
}

// Wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  let paused = false;

  // TODO (ronag): Should this.destroy(err) emit
  // 'error' on the wrapped stream? Would require
  // a static factory method, e.g. Readable.wrap(stream).

  stream.on('data', (chunk) => {
    if (!this.push(chunk) && stream.pause) {
      paused = true;
      stream.pause();
    }
  });

  stream.on('end', () => {
    this.push(null);
  });

  stream.on('error', (err) => {
    errorOrDestroy(this, err);
  });

  stream.on('close', () => {
    this.destroy();
  });

  stream.on('destroy', () => {
    this.destroy();
  });

  this._read = () => {
    if (paused && stream.resume) {
      paused = false;
      stream.resume();
    }
  };

  // Proxy all the other methods. Important when wrapping filters and duplexes.
  const streamKeys = ObjectKeys(stream);
  for (let j = 1; j < streamKeys.length; j++) {
    const i = streamKeys[j];
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = stream[i].bind(stream);
    }
  }

  return this;
};

Readable.prototype[SymbolAsyncIterator] = function () {
  let stream = this;

  if (typeof stream.read !== 'function') {
    // v1 stream
    const src = stream;
    stream = new Readable({
      objectMode: true,
      destroy(err, callback) {
        destroyImpl.destroyer(src, err);
        callback(err);
      },
    }).wrap(src);
  }

  const iter = createAsyncIterator(stream);
  iter.stream = stream;
  return iter;
};

async function* createAsyncIterator(stream) {
  let callback = nop;

  function next(resolve) {
    if (this === stream) {
      callback();
      callback = nop;
    } else {
      callback = resolve;
    }
  }

  const state = stream._readableState;

  let error = state.errored;
  let errorEmitted = state.errorEmitted;
  let endEmitted = state.endEmitted;
  let closeEmitted = state.closeEmitted;

  stream
    .on('readable', next)
    .on('error', function (err) {
      error = err;
      errorEmitted = true;
      next.call(this);
    })
    .on('end', function () {
      endEmitted = true;
      next.call(this);
    })
    .on('close', function () {
      closeEmitted = true;
      next.call(this);
    });

  try {
    while (true) {
      const chunk = stream.destroyed ? null : stream.read();
      if (chunk !== null) {
        yield chunk;
      } else if (errorEmitted) {
        throw error;
      } else if (endEmitted) {
        break;
      } else if (closeEmitted) {
        break;
      } else {
        await new Promise(next);
      }
    }
  } catch (err) {
    destroyImpl.destroyer(stream, err);
    throw err;
  } finally {
    if (state.autoDestroy || !endEmitted) {
      // TODO(ronag): ERR_PREMATURE_CLOSE?
      destroyImpl.destroyer(stream, null);
    }
  }
}

// Making it explicit these properties are not enumerable
// because otherwise some prototype manipulation in
// userland will fail.
ObjectDefineProperties(Readable.prototype, {
  readable: {
    get() {
      const r = this._readableState;
      // r.readable === false means that this is part of a Duplex stream
      // where the readable side was disabled upon construction.
      // Compat. The user might manually disable readable side through
      // deprecated setter.
      return (
        !!r &&
        r.readable !== false &&
        !r.destroyed &&
        !r.errorEmitted &&
        !r.endEmitted
      );
    },
    set(val) {
      // Backwards compat.
      if (this._readableState) {
        this._readableState.readable = !!val;
      }
    },
  },

  readableHighWaterMark: {
    enumerable: false,
    get: function () {
      return this._readableState.highWaterMark;
    },
  },

  readableBuffer: {
    enumerable: false,
    get: function () {
      return this._readableState && this._readableState.buffer;
    },
  },

  readableFlowing: {
    enumerable: false,
    get: function () {
      return this._readableState.flowing;
    },
    set: function (state) {
      if (this._readableState) {
        this._readableState.flowing = state;
      }
    },
  },

  readableLength: {
    enumerable: false,
    get() {
      return this._readableState.length;
    },
  },

  readableObjectMode: {
    enumerable: false,
    get() {
      return this._readableState ? this._readableState.objectMode : false;
    },
  },

  readableEncoding: {
    enumerable: false,
    get() {
      return this._readableState ? this._readableState.encoding : null;
    },
  },

  destroyed: {
    enumerable: false,
    get() {
      if (this._readableState === undefined) {
        return false;
      }
      return this._readableState.destroyed;
    },
    set(value) {
      // We ignore the value if the stream
      // has not been initialized yet.
      if (!this._readableState) {
        return;
      }

      // Backward compatibility, the user is explicitly
      // managing destroyed.
      this._readableState.destroyed = value;
    },
  },

  readableEnded: {
    enumerable: false,
    get() {
      return this._readableState ? this._readableState.endEmitted : false;
    },
  },
});

ObjectDefineProperties(ReadableState.prototype, {
  // Legacy getter for `pipesCount`.
  pipesCount: {
    get() {
      return this.pipes.length;
    },
  },

  // Legacy property for `paused`.
  paused: {
    get() {
      return this[kPaused] !== false;
    },
    set(value) {
      this[kPaused] = !!value;
    },
  },
});

// Exposed for testing purposes only.
Readable._fromList = fromList;

/**
 * 从缓存读取数据
 *
 * Pluck off n bytes from an array of buffers.
 * Length is the combined lengths of all the buffers in the list.
 * This function is designed to be inlinable, so please take care when making
 * changes to the function body.
 * @param {*} n
 * @param {*} state
 * @return {*} 
 */
function fromList(n, state) {
  // 如果缓存数据为空，则直接返回
  // nothing buffered.
  if (state.length === 0) return null;

  let ret;
  // 如果是 objectMode 模式，则直接返回第一个 buffer 的数据
  if (state.objectMode) ret = state.buffer.shift();
  // 如果 n 为 0 ，或者 n 大于当前的缓存数据量，则返回所有数据
  else if (!n || n >= state.length) {
    // Read it all, truncate the list.
    if (state.decoder) ret = state.buffer.join('');
    else if (state.buffer.length === 1) ret = state.buffer.first();
    else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // 读取部分缓存数据
    // read part of list.
    ret = state.buffer.consume(n, state.decoder);
  }

  // 返回数据
  return ret;
}

function endReadable(stream) {
  const state = stream._readableState;

  debug('endReadable', state.endEmitted);
  // 如果 end 事件没有触发
  if (!state.endEmitted) {
    // 设置 ended 标识为 true
    state.ended = true;
    // 下一个 event loop 执行 endReadableNT 
    process.nextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  debug('endReadableNT', state.endEmitted, state.length);

  // Check that we didn't get one last unshift.
  if (
    !state.errorEmitted &&
    !state.closeEmitted &&
    !state.endEmitted &&
    state.length === 0
  ) {
    // 触发 end 事件
    state.endEmitted = true;
    stream.emit('end');

    if (stream.writable && stream.allowHalfOpen === false) {
      process.nextTick(endWritableNT, state, stream);
    } else if (state.autoDestroy) {
      // In case of duplex streams we need a way to detect
      // if the writable side is ready for autoDestroy as well.
      const wState = stream._writableState;
      const autoDestroy =
        !wState ||
        (wState.autoDestroy &&
          // We don't expect the writable to ever 'finish'
          // if writable is explicitly set to false.
          (wState.finished || wState.writable === false));

      // 触发 destroy 事件
      if (autoDestroy) {
        stream.destroy();
      }
    }
  }
}

function endWritableNT(state, stream) {
  const writable =
    stream.writable && !stream.writableEnded && !stream.destroyed;
  if (writable) {
    stream.end();
  }
}

Readable.from = function (iterable, opts) {
  if (from === undefined) {
    from = require('internal/streams/from');
  }
  return from(Readable, iterable, opts);
};
