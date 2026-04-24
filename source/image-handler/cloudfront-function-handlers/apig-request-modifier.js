// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0


function handler(event) {
    var request = event.request;
    var qs = request.querystring;

    // 阿里云 OSS 图片处理参数适配：将 x-oss-process 转换为 Base64 JSON 路径
    if (qs && qs['x-oss-process']) {
        var ossValue = qs['x-oss-process'].value || '';
        var edits = parseOssProcess(ossValue);
        if (edits) {
            // 从 URI 中提取图片 key（去掉开头的 /）
            var key = request.uri.replace(/^\/+/, '');
            var jsonObj = { key: key, edits: edits };
            // Base64 编码后替换 URI，走 DEFAULT 请求类型
            var encoded = base64Encode(JSON.stringify(jsonObj));
            request.uri = '/' + encoded;
            // 清空 query string，不再需要
            request.querystring = {};
            return request;
        }
    }

    // 原有逻辑：normalize accept header
    if(request.headers && request.headers.accept && request.headers.accept.value) {
        request.headers.accept.value = request.headers.accept.value.indexOf("image/webp") > -1 ? "image/webp" : ""
    }
    request.querystring = processQueryParams(qs).join('&')
    return request;
}

// 解析 x-oss-process 参数，返回 Sharp edits 对象
function parseOssProcess(value) {
    if (!value.startsWith('image/')) return null;
    var operations = value.split('/').slice(1);
    var edits = {};
    for (var i = 0; i < operations.length; i++) {
        var parts = operations[i].split(',');
        var op = parts[0];
        if (op === 'resize') {
            var resize = {};
            for (var j = 1; j < parts.length; j++) {
                var idx = parts[j].indexOf('_');
                if (idx === -1) continue;
                var k = parts[j].substring(0, idx);
                var v = parts[j].substring(idx + 1);
                if (k === 'w') resize.width = parseInt(v, 10);
                if (k === 'h') resize.height = parseInt(v, 10);
            }
            if (resize.width || resize.height) {
                resize.fit = 'cover';
                edits.resize = resize;
            }
        } else if (op === 'quality') {
            for (var j = 1; j < parts.length; j++) {
                var idx = parts[j].indexOf('_');
                if (idx === -1) continue;
                var k = parts[j].substring(0, idx);
                var v = parseInt(parts[j].substring(idx + 1), 10);
                if ((k === 'q' || k === 'Q') && v >= 1 && v <= 100) {
                    edits.jpeg = { quality: v };
                }
            }
        }
    }
    // 默认 quality 95 + sharpen
    if (!edits.jpeg) edits.jpeg = { quality: 95 };
    if (edits.resize) edits.sharpen = true;
    return Object.keys(edits).length > 0 ? edits : null;
}

// CloudFront Function 兼容的 Base64 编码（不能用 Buffer/btoa）
function base64Encode(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var bytes = [];
    for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
    var result = '';
    for (var i = 0; i < bytes.length; i += 3) {
        var b1 = bytes[i], b2 = i + 1 < bytes.length ? bytes[i + 1] : 0, b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        result += chars[b1 >> 2];
        result += chars[((b1 & 3) << 4) | (b2 >> 4)];
        result += i + 1 < bytes.length ? chars[((b2 & 15) << 2) | (b3 >> 6)] : '=';
        result += i + 2 < bytes.length ? chars[b3 & 63] : '=';
    }
    return result;
}

function processQueryParams(querystring) {
    if (querystring == null) {
        return [];
    }

    const ALLOWED_PARAMS = ['signature', 'expires', 'format', 'fit', 'width', 'height', 'rotate', 'flip', 'flop', 'grayscale', 'x-oss-process'];
    
    let qs = [];
    for (const key in querystring) {
        if (!ALLOWED_PARAMS.includes(key)) {
            continue;
        }
        const value = querystring[key];
        qs.push(
            value.multiValue
                ? `${key}=${value.multiValue[value.multiValue.length - 1].value}`
                : `${key}=${value.value}`
        )
    }

    return qs.sort();
}
module.exports = { handler };