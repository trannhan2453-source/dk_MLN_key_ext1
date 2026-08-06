const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================================
// 1. DANH SÁCH THIẾT BỊ ĐƯỢC PHÉP HOẠT ĐỘNG (WHITELIST)
// Khai báo sẵn các ID và KEY hợp lệ tại đây (hoặc lấy từ DB)
// ==========================================================
const ALLOWED_DEVICES = {
    "MAY_LOC_01": "123456",
    "MAY_LOC_02": "654321",
    "MAY_LOC_03": "888888"
};

// Thời gian tối đa (milisecond) không có tín hiệu thì tính là Offline (ví dụ: 30 giây)
const ONLINE_TIMEOUT = 30000; 

// Lưu trữ dữ liệu RUNTIME của các thiết bị đang hoạt động
const devices = {};

// Hàm hỗ trợ kiểm tra thiết bị có đang Online hay không
function isOnline(deviceId) {
    if (!devices[deviceId] || !devices[deviceId].lastSeen) return false;
    return (Date.now() - devices[deviceId].lastSeen) < ONLINE_TIMEOUT;
}

function getOrCreateDevice(deviceId) {
    if (!devices[deviceId]) {
        devices[deviceId] = {
            secretKey: ALLOWED_DEVICES[deviceId] || "",
            data: {
                type: "NONE",
                d1: "N/A", d2: "N/A", d3: "N/A", d4: "N/A", d5: "N/A", d6: "N/A",        
                tag: "", value: ""
            },
            commands: {
                co_kiem: 0,
                co_axit: 0,
                co_tinhkhiet: 0,
                co_onoff: 0,
                co_volume: 0
            },
            lastSeen: 0
        };
    }
    return devices[deviceId];
}

// ==========================================
// --- API DÀNH CHO APP INVENTOR ---
// ==========================================

// 0. API RIÊNG CHO APP CHECK TỒN TẠI & TRẠNG THÁI ONLINE
// App gửi JSON body hoặc Query: { "device_id": "MAY_LOC_01", "secret_key": "123456" }
app.post('/api/check-device', (req, res) => {
    const { device_id, secret_key } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key" });
    }

    // 1. Kiểm tra ID có trong danh sách cho phép không
    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) {
        return res.json({ 
            status: "ERROR", 
            exists: false, 
            online: false, 
            message: "Thiết bị không tồn tại trên Server!" 
        });
    }

    // 2. Kiểm tra Key có đúng không
    if (ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.json({ 
            status: "ERROR", 
            exists: true, 
            validKey: false, 
            online: false, 
            message: "Mã PIN (Secret Key) không chính xác!" 
        });
    }

    // 3. Kiểm tra Trạng thái Online
    const onlineStatus = isOnline(device_id);

    return res.json({
        status: "OK",
        exists: true,
        validKey: true,
        online: onlineStatus,
        message: onlineStatus ? "Thiết bị hợp lệ và đang Online" : "Thiết bị hợp lệ nhưng đang Offline"
    });
});

// 1. App lấy dữ liệu hiển thị (?device_id=MAY_LOC_01&secret_key=123456)
app.get('/api/getdata', (req, res) => {
    const { device_id, secret_key } = req.query;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    const device = getOrCreateDevice(device_id);
    res.json({
        ...device.data,
        online: isOnline(device_id) // Trả thêm cờ online cho App
    });
});

// 2. App gửi lệnh điều khiển (body: device_id, secret_key, cmd)
app.post('/api/control', (req, res) => {
    const { device_id, secret_key, cmd } = req.body;

    if (!device_id || !ALLOWED_DEVICES[device_id]) {
        return res.status(404).json({ status: "ERROR", message: "Thiết bị không tồn tại" });
    }

    if (!secret_key || ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(403).json({ status: "ERROR", message: "Mã PIN không chính xác!" });
    }

    const device = getOrCreateDevice(device_id);

    if (cmd && device.commands.hasOwnProperty(`co_${cmd}`)) {
        device.commands[`co_${cmd}`] = 1;
        return res.json({ status: "OK", message: `Đã ghi nhận lệnh ${cmd}` });
    }

    res.status(400).json({ status: "ERROR", message: "Lệnh không hợp lệ" });
});

// ==========================================
// --- API DÀNH CHO ESP8266 ---
// ==========================================

app.post('/api/esp-sync', (req, res) => {
    const { device_id, secret_key, type } = req.body;

    if (!device_id || !secret_key) {
        return res.status(400).json({ status: "ERROR", message: "Thiếu device_id hoặc secret_key từ ESP" });
    }

    // --- KIỂM TRA WHITELIST ---
    // 1. Nếu ID không có trong ALLOWED_DEVICES -> Từ chối kết nối
    if (!ALLOWED_DEVICES.hasOwnProperty(device_id)) {
        return res.status(403).json({ status: "ERROR", message: "ID thiết bị này chưa được cấp phép trên Server!" });
    }

    // 2. Nếu KEY không khớp -> Từ chối
    if (ALLOWED_DEVICES[device_id] !== secret_key) {
        return res.status(401).json({ status: "ERROR", message: "Mã Secret Key của ESP không đúng!" });
    }

    // Nếu hợp lệ thì khởi tạo / lấy dữ liệu runtime
    const device = getOrCreateDevice(device_id);
    
    // Cập nhật timestamp hoạt động mới nhất
    device.lastSeen = Date.now();

    // Lưu dữ liệu cảm biến gửi lên từ ESP
    if (type) {
        if (type === "MULTI") {
            if (req.body.d1 && !req.body.d1.includes(':')) {
                device.data = {
                    type: type,
                    d1: req.body.d1, d2: req.body.d2,
                    d3: req.body.d3, d4: req.body.d4,
                    d5: req.body.d5, d6: req.body.d6
                };
            }
        } else {
            device.data = {
                type: type,
                tag: req.body.tag || "",
                value: req.body.value || ""
            };
        }
    }

    // Phản hồi các lệnh đang chờ của riêng thiết bị này cho ESP8266
    res.json(device.commands);

    // Reset các cờ lệnh sau khi gửi cho ESP
    for (let key in device.commands) {
        device.commands[key] = 0;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
