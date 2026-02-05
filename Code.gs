// ========== CONFIG ==========
const SPREADSHEET_ID = "1nSdL-kbh1MOlA_hy3pxUO-QCk7G8BJJqiicp7OlR_58";
const SHEET_DATA = "Base Smart Huay";
const TELEGRAM_TOKEN = "8252129230:AAGbs-zbIHgA8XOlDRwax03nQOccDiTzI7k";
const GROUP_ID = "-5238339016";

/**
 * Handles both GET (serve HTML) and POST (save order) requests
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle('Smart Huay Pro')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Handles POST requests from the frontend
 * Accepts JSON payload and saves to spreadsheet + Telegram
 */
function doPost(e) {
  try {
    let data;
    
    // Parse the request body
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e.parameter && e.parameter.payload) {
      data = JSON.parse(e.parameter.payload);
    } else {
      throw new Error("No data received");
    }
    
    // Save the order
    const result = saveOrder(data);
    
    // Return JSON response (CORS is handled by Apps Script automatically)
    return ContentService.createTextOutput(result)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const errorResponse = JSON.stringify({ 
      status: "error", 
      message: "Invalid request: " + err.toString() 
    });
    return ContentService.createTextOutput(errorResponse)
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Saves lottery order to Google Sheet and sends Telegram notification
 * @param {Object} data - Order data {customer, payment, orders: [{type, number, position, amount, animal}]}
 * @returns {String} JSON response {status: "success|error", message: "..."}
 */
function saveOrder(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000); 

    // Validate input
    if (!data) {
      throw new Error("ไม่ได้รับข้อมูล");
    }
    if (!data.orders || !Array.isArray(data.orders) || data.orders.length === 0) {
      throw new Error("ไม่พบรายการสั่งซื้อ");
    }

    // Get or create sheet
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(SHEET_DATA);
    
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_DATA);
    }

    // Add headers if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["วันที่", "ลูกค่า", "ประเภท", "เลข", "ตำแหน่ง", "จำนวนเงิน", "การชำระ", "นามสัตว์"]);
    }

    // Prepare data for logging
    const now = new Date();
    const timestamp = Utilities.formatDate(now, "GMT+7", "dd/MM/yyyy HH:mm:ss");
    const rows = [];
    let orderTable = "";
    let totalAll = 0;

    // Process each order
    data.orders.forEach(item => {
      // Validate and clean amount
      const amt = parseInt(String(item.amount).replace(/,/g, '')) || 0;
      
      if (amt <= 0) {
        throw new Error(`เลข ${item.number} มีจำนวนเงินไม่ถูกต้อง`);
      }
      
      totalAll += amt;
      const typeIcon = (item.type === "thai") ? "🇹🇭" : "🇱🇦";
      
      // Format for Telegram message
      orderTable += `${String(item.number).padEnd(4, " ")} | ${typeIcon} | ${String(item.position || "ปกติ").padEnd(4, " ")} | ${amt.toLocaleString()}\n`;
      
      // Prepare sheet row
      rows.push([
        timestamp,
        data.customer || "ทั่วไป",
        item.type === "thai" ? "ไทย" : "ลาว",
        "'" + item.number,  // Prefix ' to prevent Google Sheets from converting to numbers
        item.position || "ปกติ",
        amt,
        data.payment || "ไม่ระบุ",
        item.animal || ""
      ]);
    });

    // Write to spreadsheet
    if (rows.length > 0) {
      try {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
      } catch (e) {
        // Fallback: append row by row
        rows.forEach(row => sheet.appendRow(row));
      }
    }

    // Send Telegram notification
    sendToTelegram(data.customer || "ทั่วไป", orderTable, totalAll, data.payment || "ไม่ระบุ", timestamp);

    return JSON.stringify({ status: "success", message: "บันทึกเรียบร้อย" });

  } catch (err) {
    console.error("Save Error: " + err.toString());
    return JSON.stringify({ 
      status: "error", 
      message: err.toString() 
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sends order notification to Telegram group
 * @param {String} cust - Customer name
 * @param {String} table - Formatted order table
 * @param {Number} total - Total amount
 * @param {String} pay - Payment method
 * @param {String} time - Timestamp
 */
function sendToTelegram(cust, table, total, pay, time) {
  try {
    let msg = `🔔 รายการสั่งซื้อใหม่\n`;
    msg += `👤 <b>ลูกค้าชื่อ:</b> ${escapeHtml(cust)}\n`;
    msg += `<code>──────────\n`;
    msg += `เลข  │ หวย │ ชุด  │ จำนวน\n`;
    msg += `──────────\n`;
    msg += `${table}`;
    msg += `──────────</code>\n`;
    msg += `💰 <b>รวมเงิน:</b> <code>${total.toLocaleString()} ₭</code>\n`;
    msg += `💳 <b>ชำระ:</b> ${pay}\n`;
    msg += `⏰ <b>เวลา:</b> ${time}`;

    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        chat_id: GROUP_ID,
        text: msg,
        parse_mode: "HTML"
      }),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());
    
    if (!result.ok) {
      console.error("Telegram error: " + result.description);
    }
  } catch (e) {
    console.error("Telegram Error: " + e.toString());
  }
}

/**
 * Escape HTML special characters for safe Telegram message
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}
