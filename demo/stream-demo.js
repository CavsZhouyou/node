const Readable = require('stream').Readable;

// 实现一个可读流
class SubReadable extends Readable {
    constructor(dataSource, options) {
        super(options);
        this.dataSource = dataSource;
    }
    // 文档提出必须通过_read方法调用push来实现对底层数据的读取
    _read() {
        console.log('阈值规定大小：', this.readableHighWaterMark + ' bytes');
        const data = this.dataSource.makeData();
        let result = this.push(data);
        if (data) console.log('添加数据大小：', data.toString().length + ' bytes');
        console.log(
        '已缓存数据大小: ',
        subReadable._readableState.length + ' bytes'
        );
        console.log('超过阈值限制或数据推送完毕：', !result);
        console.log('====================================');
    }
}

// 模拟资源池
const dataSource = {
    data: new Array(10000).fill('1'),
    // 每次读取时推送一定量数据
    makeData() {
        if (!dataSource.data.length) return null;
        return dataSource.data
        .splice(dataSource.data.length - 5000)
        .reduce((a, b) => a + '' + b);
    },
    //每次向缓存推5000字节数据
};

const subReadable = new SubReadable(dataSource);

subReadable.on('data', (chunk) => {
console.log(
    '缓存剩余数据大小: ',
    subReadable._readableState.length + ' byte'
);
console.log('------------------------------------');
});