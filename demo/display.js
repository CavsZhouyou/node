const Readable = require('stream').Readable;

// 实现一个可读流
class CustomReadable extends Readable {
    readTimes = 1;
    constructor(dataSource, options) {
        super(options);
        this.dataSource = dataSource;
    }
    // 文档提出必须通过 _read 方法调用 push 来实现对底层数据的读取（同步）
    _read() {
        console.log(`================= 第 ${this.readTimes++} 次通过 _read() 获取数据 ===================`);
        console.log('hwm: ', this.readableHighWaterMark + ' bytes');
        const data = this.dataSource.makeData();
        let result = this.push(data);
        if (data) console.log('chunk: ', data.toString().length + ' bytes');
        console.log(
        '缓存池剩余数据大小: ',
        this._readableState.length + ' bytes'
        );
        console.log('还可继续推送数据：', result);
        console.log();
    }
    
}

// 模拟资源池
const dataSource = {
    data: new Array(25000).fill('1'),
    //每次向缓存推 5000 字节数据
    makeData() {
        if (!dataSource.data.length) return null;
        return dataSource.data
        .splice(dataSource.data.length - 5000)
        .reduce((a, b) => a + '' + b);
    },
};

const customReadable = new CustomReadable(dataSource);

/**
 * 示例 2
 * 监听 readable 事件，每次通过 read() 读取数据
 */
// let readableTimes = 1;
// let consumer = '';
// customReadable.on('readable', () => {
//     console.log(`----------------- 第 ${readableTimes} 次触发 readable 事件 start -------------------`);
//     console.log(
//         '缓存池剩余数据大小: ',
//         customReadable._readableState.length + ' bytes'
//     );
//     consumer += customReadable.read();
//     console.log('消费者获取数据：', consumer.length);
//     console.log(`----------------- 第 ${readableTimes++} 次触发 readable 事件 end   -------------------\n`);
// });

/**
 * 示例 
 * 监听 data 事件
 */
let dataTimes = 1;
let consumer = '';
customReadable.on('data', (chunk) => {
    console.log(`----------------- 第 ${dataTimes} 次 data 事件 start -------------------`);
    console.log(
        '缓存剩余数据大小: ',
        customReadable._readableState.length + ' bytes'
    );
    consumer += chunk;
    console.log('消费者获取数据', consumer.length);
    console.log(`----------------- 第 ${dataTimes++} 次 data 事件 end   -------------------\n`);
});


customReadable.on('end', () => {
    console.log(`----------------- 触发 end 事件 -------------------\n`);
});
customReadable.on('close', () => {
    console.log(`----------------- 触发 close 事件 -------------------\n`);
});