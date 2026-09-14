/************************************************
 * SCHOOL OF LEADERS 1 (SOL 1) DASHBOARD API
 * Cloned from the LIFECLASS backend so the same dashboard code,
 * QR flow, and sheet layout work unchanged for SOL 1.
 *
 * ⚠️  REQUIRED SETUP — do this before deploying:
 *  1. Create a brand-new Google Sheet (separate from the Lifeclass one)
 *     and import SOL1_DATABASE_SEED.xlsx into it — File > Import >
 *     Upload > "Insert new sheet(s)". This creates all 15 tabs
 *     (STUDENTS pre-filled with everyone who was Active in Lifeclass,
 *     their Student IDs unchanged) and a PROMOTION_LOG audit tab.
 *  2. Copy the new Sheet's ID from its URL:
 *     https://docs.google.com/spreadsheets/d/ >>>COPY_THIS_PART<<< /edit
 *  3. Paste it below, replacing the placeholder
 *  4. Deploy → Manage deployments → New deployment
 *     Execute as: Me | Who has access: Anyone
 *  5. Paste the resulting Web App URL into GAS_URL at the top of
 *     js/script1.js in the SOL1 dashboard folder.
 *
 * STUDENT ID CONTINUITY: this script never generates a new Student ID
 * for anyone already assigned one in Lifeclass — it only ever reads/
 * writes the ID that's already in the Student ID column. When SOL 1
 * students later move up to SOL 2, repeat this same clone process:
 * copy their STUDENTS row (same ID) into the new SOL 2 sheet and log
 * it in that sheet's PROMOTION_LOG tab. That keeps one ID per student
 * all the way through SOL 1 → SOL 2 → SOL 3.
 ************************************************/

const SPREADSHEET_ID = "1j5xhkCDSgAVNMVFS3Mp5Xah499mfco2o3LB_Eakig4o"; // ← REPLACE THIS

/************************************************
 * NEW SHEETS REQUIRED IN YOUR GOOGLE SPREADSHEET:
 *
 * Sheet: STUDENT_DEVOTIONALS
 * Headers (Row 1):
 *   Devotional ID | Student ID | Student Name | Table No | Day No | Completed | Date Marked | Marked By
 *
 * Sheet: STUDENT_ACTIVITIES
 * Headers (Row 1):
 *   Activity ID | Student ID | Student Name | Table No | Day No | Completed | Date Marked | Marked By
 *
 * Sheet: TABLE_GUIDES
 * Headers (Row 1):
 *   Table No | Facilitator ID | Facilitator Name | Table Name | Total Students | Notes
 *   ↑ Add "Table Name" column (Column D) — e.g. "Glorious Warrior"
 *   The dashboard will display "Name | Table X" everywhere a table is shown.
 * Headers (Row 1):
 *   Makeup ID | Attendance ID | Student ID | Student Name | Week No | Table No | Status | Updated By | Updated At | Notes
 ************************************************/

/************************************************
 * GET REQUESTS
 ************************************************/

function doGet(e) {
  try {
    const action = e.parameter.action;

    switch (action) {

      case "students":
        return output(getSheetData("STUDENTS"));

      case "faculty":
        return output(getSheetData("FACULTY_STAFF"));

      case "lessonWeeks":
        return output(getSheetData("LESSON_WEEKS"));

      case "studentAttendance":
        return output(getSheetData("STUDENT_ATTENDANCE"));

      case "facultyAttendance":
        return output(getSheetData("FACULTY_ATTENDANCE"));

      case "payments":
        return output(getSheetData("PAYMENTS"));

      case "credits":
        return output(getSheetData("LC_CREDITS"));

      case "qrscans":
        return output(getSheetData("QR_SCANS"));

      case "tableGuides":
        return output(getSheetData("TABLE_GUIDES"));

      case "settings":
        return output(getSheetData("SYSTEM_SETTINGS"));

      // NEW: Devotionals
      case "devotionals":
        return output(getSheetData("STUDENT_DEVOTIONALS"));

      // NEW: Activities
      case "activities":
        return output(getSheetData("STUDENT_ACTIVITIES"));

      // NEW: Makeup status records
      case "makeupStatus":
        return output(getSheetData("MAKEUP_STATUS"));

      // NEW: Promotion history (which students carried their ID in from Lifeclass)
      case "promotionLog":
        return output(getSheetData("PROMOTION_LOG"));

      // ── GAME SHOW STATE (cross-device sync) ──
      case "gameState":
        var gsRaw = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        return output({ state: gsRaw ? JSON.parse(gsRaw) : null });

      case "student":
        return output(getStudentById(e.parameter.studentId));

      case "facultyMember":
        return output(getFacultyById(e.parameter.facultyId));

      default:
        return output({
          success: false,
          message: "Invalid action: " + action
        });
    }

  } catch (error) {
    return output({
      success: false,
      error: error.toString()
    });
  }
}

/************************************************
 * POST REQUESTS
 ************************************************/

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    switch (data.action) {

      case "addAttendance":
        return output(addAttendance(data));

      case "addFacultyAttendance":
        return output(addFacultyAttendance(data));

      case "addPayment":
        return output(addPayment(data));

      case "addCredit":
        return output(addCredit(data));

      case "addQRScan":
        return output(addQRScan(data));

      // NEW: Toggle a single devotional day for a student
      case "toggleDevotional":
        return output(toggleDevotional(data));

      // NEW: Toggle a single activity day for a student
      case "toggleActivity":
        return output(toggleActivity(data));

      // NEW: Bulk-save all devotional days for a student (replaces existing rows)
      case "saveStudentDevotionals":
        return output(saveStudentDevotionals(data));

      // NEW: Bulk-save all activity days for a student (replaces existing rows)
      case "saveStudentActivities":
        return output(saveStudentActivities(data));

      // NEW: Update makeup status for an absence record
      case "updateMakeupStatus":
        return output(updateMakeupStatus(data));

      // NEW: Update student status (Active / Dropped)
      case "updateStudentStatus":
        return output(updateStudentStatus(data));

      // NEW: Log a student being promoted into this level with their
      // existing Student ID (used when moving SOL1 -> SOL2 later, or to
      // add a late-arriving Lifeclass graduate to this SOL1 sheet).
      case "addPromotionLog":
        return output(addPromotionLog(data));

      // ── GAME SHOW STATE (cross-device sync) ──
      case "setGameState":
        PropertiesService.getScriptProperties().setProperty("GS_GAME_STATE", JSON.stringify(data.state));
        return output({ success: true });

      // appendGameEvent — used by phones to add a single event (buzz) without
      // overwriting the host's full event queue
      case "appendGameEvent":
        var gsAppRaw = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        var gsAppState = gsAppRaw ? JSON.parse(gsAppRaw) : { events: [] };
        if (!gsAppState.events) gsAppState.events = [];
        gsAppState.events.push(data.event);
        if (gsAppState.events.length > 40) gsAppState.events = gsAppState.events.slice(-40);
        PropertiesService.getScriptProperties().setProperty("GS_GAME_STATE", JSON.stringify(gsAppState));
        return output({ success: true });

      // getGameState via POST — avoids GAS GET CDN caching on mobile devices
      case "getGameState":
        var gsRaw2 = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        return output({ state: gsRaw2 ? JSON.parse(gsRaw2) : null });

      case "clearGameState":
        PropertiesService.getScriptProperties().deleteProperty("GS_GAME_STATE");
        return output({ success: true });


      default:
        return output({
          success: false,
          message: "Unknown action: " + data.action
        });
    }

  } catch (error) {
    return output({
      success: false,
      error: error.toString()
    });
  }
}

/************************************************
 * SHEET CORE
 ************************************************/

function getSheet(sheetName) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error("Sheet not found: " + sheetName);
  }
  return sheet;
}

function getSheetData(sheetName) {
  const sheet  = getSheet(sheetName);
  const values = sheet.getDataRange().getValues();

  if (values.length < 1) {
    return { success: true, data: [] };
  }

  const headers = values.shift(); // first row = column headers

  const data = values.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });

  return {
    success: true,
    data: data
  };
}

/************************************************
 * STUDENT LOOKUP
 ************************************************/

function getStudentById(studentId) {
  const students = getSheetData("STUDENTS").data;
  const student  = students.find(
    s => String(s["Student ID"]) === String(studentId)
  );
  return {
    success: true,
    data: student || null
  };
}

/************************************************
 * FACULTY LOOKUP
 ************************************************/

function getFacultyById(facultyId) {
  const faculty = getSheetData("FACULTY_STAFF").data;
  const person  = faculty.find(
    f => String(f["Faculty ID"]) === String(facultyId)
  );
  return {
    success: true,
    data: person || null
  };
}

/************************************************
 * STUDENT ATTENDANCE
 ************************************************/

function addAttendance(data) {
  const sheet = getSheet("STUDENT_ATTENDANCE");
  sheet.appendRow([
    Utilities.getUuid(),          // Attendance ID
    data.studentId,               // Student ID
    data.studentName,             // Student Name
    data.age        || "",        // Age
    data.gender     || "",        // Gender
    data.lgLeader   || "",        // LG Leader
    data.networkLeader || "",     // Network Leader
    data.tableNo    || "",        // Table No
    data.weekNo,                  // Week No
    data.status,                  // Attendance Status
    new Date(),                   // Scan Time
    data.remarks    || "",        // Remarks
    "Pending"                     // Makeup Status (new column — default Pending for absences)
  ]);
  return {
    success: true,
    message: "Attendance Recorded"
  };
}

/************************************************
 * FACULTY ATTENDANCE
 ************************************************/

function addFacultyAttendance(data) {
  const sheet = getSheet("FACULTY_ATTENDANCE");
  sheet.appendRow([
    Utilities.getUuid(),
    data.facultyId,
    data.facultyName,
    data.role,
    data.weekNo,
    data.status,
    new Date()
  ]);
  return {
    success: true,
    message: "Faculty Attendance Recorded"
  };
}

/************************************************
 * PAYMENTS
 ************************************************/

function addPayment(data) {
  const sheet = getSheet("PAYMENTS");
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.amountPaid,
    data.balance,
    new Date(),
    data.status
  ]);
  return {
    success: true,
    message: "Payment Added"
  };
}

/************************************************
 * CREDITS
 ************************************************/

function addCredit(data) {
  const sheet = getSheet("LC_CREDITS");
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.reason,
    data.creditsAdded,
    new Date(),
    data.addedBy
  ]);
  return {
    success: true,
    message: "Credit Added"
  };
}

/************************************************
 * QR SCANS
 ************************************************/

function addQRScan(data) {
  const sheet = getSheet("QR_SCANS");
  sheet.appendRow([
    Utilities.getUuid(),
    data.qrCode,
    data.personType,
    data.personId,
    data.name,
    data.weekNo,
    data.scanType,
    new Date()
  ]);
  return {
    success: true,
    message: "QR Logged"
  };
}

/************************************************
 * DEVOTIONALS — Toggle single day
 * data: { studentId, studentName, tableNo, dayNo, completed, markedBy }
 ************************************************/

function toggleDevotional(data) {
  const sheet  = getSheet("STUDENT_DEVOTIONALS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const dayNoCol     = headers.indexOf("Day No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  // Check if row already exists for this student + day
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][dayNoCol]) === Number(data.dayNo)) {
      // Update existing row
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      return { success: true, message: "Devotional updated" };
    }
  }

  // Insert new row
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.dayNo,
    data.completed ? "Yes" : "No",
    new Date(),
    data.markedBy || ""
  ]);
  return { success: true, message: "Devotional recorded" };
}

/************************************************
 * ACTIVITIES — Toggle single day
 * data: { studentId, studentName, tableNo, dayNo, completed, markedBy }
 ************************************************/

function toggleActivity(data) {
  const sheet  = getSheet("STUDENT_ACTIVITIES");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const dayNoCol     = headers.indexOf("Day No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  // Check if row already exists for this student + day
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][dayNoCol]) === Number(data.dayNo)) {
      // Update existing row
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      return { success: true, message: "Activity updated" };
    }
  }

  // Insert new row
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.dayNo,
    data.completed ? "Yes" : "No",
    new Date(),
    data.markedBy || ""
  ]);
  return { success: true, message: "Activity recorded" };
}

/************************************************
 * DEVOTIONALS — Bulk save all days for a student
 * data: { studentId, studentName, tableNo, days: number[], markedBy }
 * "days" = array of day numbers that are completed
 ************************************************/

function saveStudentDevotionals(data) {
  const sheet  = getSheet("STUDENT_DEVOTIONALS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  // Delete all existing rows for this student (go bottom-up)
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  // Re-insert all completed days
  const completedDays = new Set(data.days || []);
  for (let day = 1; day <= 63; day++) {
    sheet.appendRow([
      Utilities.getUuid(),
      data.studentId,
      data.studentName,
      data.tableNo,
      day,
      completedDays.has(day) ? "Yes" : "No",
      new Date(),
      data.markedBy || ""
    ]);
  }
  return { success: true, message: "Devotionals saved" };
}

/************************************************
 * ACTIVITIES — Bulk save all days for a student
 ************************************************/

function saveStudentActivities(data) {
  const sheet  = getSheet("STUDENT_ACTIVITIES");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  // Delete all existing rows for this student
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  // Re-insert all completed days
  const completedDays = new Set(data.days || []);
  for (let day = 1; day <= 63; day++) {
    sheet.appendRow([
      Utilities.getUuid(),
      data.studentId,
      data.studentName,
      data.tableNo,
      day,
      completedDays.has(day) ? "Yes" : "No",
      new Date(),
      data.markedBy || ""
    ]);
  }
  return { success: true, message: "Activities saved" };
}

/************************************************
 * MAKEUP STATUS — Update status on an absence record
 * Statuses: Pending | Scheduled | Done
 * data: { attendanceId, studentId, studentName, weekNo, tableNo, status, updatedBy, notes }
 ************************************************/

function updateMakeupStatus(data) {
  const sheet  = getSheet("MAKEUP_STATUS");
  const values = sheet.getDataRange().getValues();

  if (values.length > 1) {
    const headers     = values[0];
    const attIdCol    = headers.indexOf("Attendance ID");
    const statusCol   = headers.indexOf("Status");
    const updByCol    = headers.indexOf("Updated By");
    const updAtCol    = headers.indexOf("Updated At");
    const notesCol    = headers.indexOf("Notes");

    // Update if existing row found
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][attIdCol]) === String(data.attendanceId)) {
        sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
        sheet.getRange(i + 1, updByCol + 1).setValue(data.updatedBy || "");
        sheet.getRange(i + 1, updAtCol + 1).setValue(new Date());
        sheet.getRange(i + 1, notesCol + 1).setValue(data.notes || "");
        return { success: true, message: "Makeup status updated to " + data.status };
      }
    }
  }

  // Insert new row
  sheet.appendRow([
    Utilities.getUuid(),          // Makeup ID
    data.attendanceId,            // Attendance ID (links back to STUDENT_ATTENDANCE)
    data.studentId,               // Student ID
    data.studentName,             // Student Name
    data.weekNo,                  // Week No
    data.tableNo,                 // Table No
    data.status,                  // Status: Pending | Scheduled | Done
    data.updatedBy || "",         // Updated By
    new Date(),                   // Updated At
    data.notes || ""              // Notes
  ]);
  return { success: true, message: "Makeup status set to " + data.status };
}

/************************************************
 * STUDENT STATUS — Update Active / Dropped
 * data: { studentId, studentName, status, notes? }
 * status values: "Active" | "Dropped"
 ************************************************/

function updateStudentStatus(data) {
  const sheet  = getSheet("STUDENTS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol     = headers.indexOf("Student ID");
  const statusCol = headers.indexOf("Status");
  const notesCol  = headers.indexOf("Drop Notes"); // optional column; add if needed

  if (idCol < 0 || statusCol < 0) {
    throw new Error("STUDENTS sheet missing 'Student ID' or 'Status' column.");
  }

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(data.studentId)) {
      sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
      // Write notes to Drop Notes column if it exists
      if (notesCol >= 0 && data.notes) {
        sheet.getRange(i + 1, notesCol + 1).setValue(data.notes);
      }
      return {
        success: true,
        message: data.studentName + " status updated to " + data.status
      };
    }
  }
  return {
    success: false,
    message: "Student not found: " + data.studentId
  };
}

/************************************************
 * PROMOTION LOG — records that a student's existing ID carried over
 * from one level to the next (e.g. LIFECLASS -> SOL 1, SOL 1 -> SOL 2).
 * data: { studentId, studentName, promotedFrom, promotedTo, promotedBy, notes? }
 * This never issues a new ID — it only logs which ID moved where.
 ************************************************/

function addPromotionLog(data) {
  const sheet = getSheet("PROMOTION_LOG");
  sheet.appendRow([
    Utilities.getUuid(),          // Promotion ID
    data.studentId,                // Student ID (unchanged, carried over)
    data.studentName,              // Full Name
    data.promotedFrom || "",       // Promoted From
    data.promotedTo   || "",       // Promoted To
    new Date(),                    // Promotion Date
    data.promotedBy   || "",       // Promoted By
    data.notes         || ""       // Notes
  ]);
  return { success: true, message: "Promotion logged for " + data.studentName };
}

/************************************************
 * OUTPUT
 ************************************************/

function output(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}