const puppeteerExtra = require("puppeteer-extra");
const pluginStealth = require("puppeteer-extra-plugin-stealth");
const twilio = require("twilio");
const { default: axios } = require("axios");
const fs = require("fs");
const { google } = require('googleapis');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Solver } = require('@2captcha/captcha-solver');

const CHECK_INTERVAL_C2T = 25 * 60 * 1000; // in minutes
const CHECK_INTERVAL_T2C = 20 * 60  * 1000; // in minutes
const SAVE_INTERVAL_TWILIO_LASTREAD = 30 * 60 * 1000; // in minutes
const MAX_AUTOMATION_RETRY = 3;
const accountSid = 'ACccc478c015420afe28a0928edcb400ba';
const authToken = '0b56678bd41c34ee65e70cbba479cf10';
const API_BASE_URL = 'https://pennedsms.com';
const client = twilio(accountSid, authToken);
const googleApiKeyPath = path.join(__dirname, 'service-account.json');
let catchAllGmail = null;
const solver = new Solver('4882400aa26190ab2c3255c7caa788d1');

puppeteerExtra.use(pluginStealth());
let twilio_last_read = {};
let api_token = '';
const log_file = fs.createWriteStream(__dirname + '/bot.log', {flags : 'a'});

const sleep = (timeout) => new Promise((resolve) => setTimeout(resolve, timeout));

// Checks whether the string contains "Jenny 13175555555+"" this format
function checkStringForNewContactCommand(str) {
  // Define regex pattern for the format: Name Number (+ or -)
  const pattern = /^(\w+)\s+(\d+)([+-])$/;

  // Use regex exec to find a match
  const match = pattern.exec(str);
  
  if (match) {
      // Extract name, number, and action from the matched groups
      const name = match[1];
      const number = match[2];
      const action = match[3];
      return { name, number, action };
  }
  
  return null;
}

const logToFile = async (log_str) => {
  log_file.write(`${new Date().toString()}: ${log_str.split("\n")[0]}\n`);
};

// Function to get unread messages
const getTwilioMessages = async (twilio_number) => {
  try {
    // Fetch messages from Twilio
    const messages = await client.messages.list({
      to: twilio_number,
      status: 'received',
      dateSentAfter: new Date(twilio_last_read[twilio_number] ?? '2024-08-31')
    });

    logToFile(`Twilio number ${twilio_number} received ${messages.length} new messages after ${twilio_last_read[twilio_number] ?? '2024-08-31'}`);

    twilio_last_read[twilio_number] = new Date().toISOString()

    return messages;
  } catch (error) {
    logToFile(`Error fetching Twilio messages for ${twilio_number}: ${error.toString()}`);
    return [];
  }
};

const sendSMS = async (from, to, body) => {
  try {
    // Send message using Twilio API
    await client.messages.create({ body, from, to });
  } catch (error) {
    logToFile(`Error Twilio sending message: ${error.toString()}`);
  }
};

const getCorrlinksMessage = async (username, password) => {
  const browser = await puppeteerExtra.launch({
    headless: false
  });

  const [page] = await browser.pages();
  const preloadFile = fs.readFileSync('inject.js', 'utf8');
  await page.evaluateOnNewDocument(preloadFile);
  page.on('console', async (msg) => {
    const txt = msg.text();
    if (txt.includes('intercepted-params:')) {
      const params = JSON.parse(txt.replace('intercepted-params:', ''));

      try {
        const res = await solver.cloudflareTurnstile(params);
        await page.evaluate((token) => {
          cfCallback(token)
        }, res.data);
      } catch (e) {}
    }
  });

  const messages = [];

  try {
    // Go to the login page
    await page.goto("https://corrlinks.com/login.aspx", {
      waitUntil: "networkidle0",
    });

    await page.waitForSelector(
      "#ctl00_mainContentPlaceHolder_loginUserNameTextBox",
      { timeout: 60000 }
    );

    // Enter email and password from .env
    await page.type(
      "#ctl00_mainContentPlaceHolder_loginUserNameTextBox",
      username
    );
    await page.type(
      "#ctl00_mainContentPlaceHolder_loginPasswordTextBox",
      password
    );

    // Click the login button
    await page.click("#ctl00_mainContentPlaceHolder_loginButton");

    // Goto inbox
    await page.goto("https://www.corrlinks.com/Inbox.aspx", {
      waitUntil: "networkidle2",
    });

    // Wait for the inbox table to appear
    await page.waitForSelector("#ctl00_mainContentPlaceHolder_UnreadMessages", {
      timeout: 10000,
    });
    await page.click("#ctl00_mainContentPlaceHolder_UnreadMessages");
    await sleep(1500);

    // Retrieve inbox messages
    const rowCnt = await page.$$eval("#ctl00_mainContentPlaceHolder_inboxGridView tr", (rows) => rows.length);

    for (let i = 2; i < rowCnt + 1; i++) {
      logToFile(`---getCorrlinksMessage--- handling ${i}th unread message of ${username}`);

      const row = await page.$("#ctl00_mainContentPlaceHolder_inboxGridView tr:nth-child(2)");
      const innerText = await row.evaluate((element) => element.innerText);
      const cells = innerText.split("\t");

      if (cells.length < 4) {
        await row.dispose();
        continue;
      }

      const rowInfo = {
        subject: cells[2],
      };

      await row.click();
      await page.waitForSelector("#ctl00_mainContentPlaceHolder_messageTextBox",
        { timeout: 10000 }
      );
      await row.dispose();

      rowInfo['message'] = await page.$eval(
        "#ctl00_mainContentPlaceHolder_messageTextBox",
        (el) => el.value
      );
      messages.push(rowInfo);

      await page.click("#ctl00_mainContentPlaceHolder_cancelButton");
      await page.waitForSelector(
        "#ctl00_mainContentPlaceHolder_UnreadMessages",
        { timeout: 10000 }
      );
    }

    return messages;
  } catch (error) {
    logToFile(`Error while reading Corrlinks Inbox for ${username}: ${error.toString()}`);
    return null;
  } finally {
    await browser.close();
  }
};

const sendMessageOnCorrlinks = async (username, password, messages) => {
  const browser = await puppeteerExtra.launch({
    headless: false
  });

  const [page] = await browser.pages();
  const preloadFile = fs.readFileSync('inject.js', 'utf8');
  await page.evaluateOnNewDocument(preloadFile);
  page.on('console', async (msg) => {
    const txt = msg.text();
    if (txt.includes('intercepted-params:')) {
      const params = JSON.parse(txt.replace('intercepted-params:', ''));

      try {
        const res = await solver.cloudflareTurnstile(params);
        await page.evaluate((token) => {
          cfCallback(token)
        }, res.data);
      } catch (e) {}
    }
  });
  
  try {
    // Go to the login page
    await page.goto("https://corrlinks.com/login.aspx", {
      waitUntil: "networkidle0",
    });

    await page.waitForSelector(
      "#ctl00_mainContentPlaceHolder_loginUserNameTextBox",
      { timeout: 60000 }
    );

    // Enter email and password
    await page.type(
      "#ctl00_mainContentPlaceHolder_loginUserNameTextBox",
      username
    );
    await page.type(
      "#ctl00_mainContentPlaceHolder_loginPasswordTextBox",
      password
    );

    // Click the login button
    await page.click("#ctl00_mainContentPlaceHolder_loginButton");
  
    const failed = [];

    for (const message of messages) {
      try {
        await page.goto("https://corrlinks.com/NewMessage.aspx", {
          waitUntil: "networkidle2",
        });

        // Wait for the address box to appear
        await page.waitForSelector(
          "#ctl00_mainContentPlaceHolder_addressBox_outerPanel",
          { timeout: 10000 }
        );

        await page.click(
          "#ctl00_mainContentPlaceHolder_addressBox_addressTextBox"
        );

        const inmate_row = await page.$(
          "#ctl00_mainContentPlaceHolder_addressBox_outerPanel tr:not(:first-child)"
        );
        const el1 = await inmate_row.$("input");
        await el1.click();
        const el2 = await page.$("#ctl00_mainContentPlaceHolder_addressBox_outerPanel #ctl00_mainContentPlaceHolder_addressBox_okButton");
        await el2.click();
        await sleep(1000);
        await el1.dispose();
        await el2.dispose();
        await inmate_row.dispose();

        // Type the subject and message
        await page.type(
          "#ctl00_mainContentPlaceHolder_subjectTextBox",
          message['subject']
        );
        await page.type(
          "#ctl00_mainContentPlaceHolder_messageTextBox",
          message['message']
        );
        
        await page.click("#ctl00_mainContentPlaceHolder_sendMessageButton");
        await sleep(2000);
      } catch (error) {
        logToFile(`Error while automation of sending message one by one: ${error.toString()}`);
        failed.push(message);
      }
    }

    return failed;
  } catch (error) {
    logToFile(`Error while automation of sending message on Corrlinks for ${username}: ${error.toString()}`);
    return messages;
  } finally {
    await browser.close();
  }
};

const handleCorrlinksToTwilio = async () => {
  // Notification mail doesn't work at the moment. Commented.
  // if (catchAllGmail == null) {
  //   return;
  // }

  // let res = await catchAllGmail.users.messages.list({
  //   userId: 'me',
  //   labelIds: ['INBOX', 'UNREAD']
  // });
  // const gmail_msgs = res.data.messages;

  // if (gmail_msgs.length == 0) {
  //   return;
  // }

  // let notified_users = [];
  // for (const gmail_msg of gmail_msgs) {
  //   res = await catchAllGmail.users.messages.get({
  //     userId: 'me',
  //     id: gmail_msg.id,
  //     format: 'metadata',
  //     metadataHeaders: ['Subject', 'From', 'To'],
  //   });

  //   const headers = res.data.payload.headers;
  //   let subject = null, sender = null, recv = null;

  //   for (const header of headers) {
  //     if (header.name === 'Subject') {
  //       subject = header.value.toLowerCase();
  //     } else if (header.name === 'From') {
  //       sender = header.value.toLowerCase();
  //     } else if (header.name === 'To') {
  //       recv = header.value;
  //     }
  //   }
    
  //   if (subject == null || sender == null || recv == null) {
  //     continue;
  //   }

  //   if (sender.indexOf('corrlinks') > -1 && subject.indexOf('new message at corrlinks') > -1) {
  //     const lessIndex = recv.indexOf('<');
  //     if (lessIndex > -1) {
  //       recv = recv.substring(lessIndex + 1, recv.length - 1);
  //     }

  //     notified_users.push(recv);
  //     await catchAllGmail.users.messages.modify({
  //       userId: 'me',
  //       id: gmail_msg.id,
  //       resource: {
  //         removeLabelIds: ['UNREAD']
  //       },
  //     });
  //   }
  // }

  // if (notified_users.length == 0) {
  //   return;
  // }

  let apiUsers = [];
  try {
    apiUsers = (await apiGet('/api/v1/user'))['data'];
  } catch(error) {
    return;
  }

  let users = [];
  // Notification mail doesn't work at the moment. Commented.
  // for (const notified_user of notified_users) {
  //   const match_user = apiUsers.find((element) => element['corrolinks_username'] === notified_user);

  //   if (match_user && match_user['twilio_number'] != null) {
  //     users.push(match_user);
  //   }
  // }
  for (const apiUser of apiUsers) {
    if (apiUser['twilio_number']) {
      users.push(apiUser);
    }
  }

  for (const user of users) {
    let messages = null;
    let tryCnt = 0;

    while (tryCnt < MAX_AUTOMATION_RETRY) {
      messages = await getCorrlinksMessage(user['corrolinks_username'], user['corrolinks_password']);
      if (messages != null) {
        break;
      }

      tryCnt++;
    }

    if (messages == null) {
      continue;
    }

    let messagesToSend = [];
    for (const message of messages) {
      try {
        const subject = message['subject'].trim().replace(/^Re:\s*/i, "");

        if (subject.toLowerCase() == 'jack') {
          const lines = message['message'].split("\n");
          const updatedContacts = [];

          for (const line of lines) {
            const contactInfo = checkStringForNewContactCommand(line.trim());

            if (contactInfo?.action == '+') {
              await apiPost('/api/v1/contact/add/contact', {
                "inmate_email":user['corrolinks_username'],
                "contact_phone_number": contactInfo.number,
                "contact_name": contactInfo.name,
                "contact_keyword": contactInfo.name
              });

              updatedContacts.push(`${contactInfo.name} ${contactInfo.number}+`);
            } else if(contactInfo?.action == '-') {
              await apiPost('/api/v1/contact/delete/by/phone-number', {
                phone_number: contactInfo?.number
              });

              updatedContacts.push(`${contactInfo.name} ${contactInfo.number}-`);
            }
          }

          if (updatedContacts.length) {
            messagesToSend.push({
              subject: 'JACK',
              message: updatedContacts.join('\n')
            });
          }
        } else {
          const phone_number = getNumberFromSubject(user, subject);

          if (phone_number) {
            await sendSMS(formatPhoneNumber(user['twilio_number']), formatPhoneNumber(phone_number), message['message']);
          }
        }
      } catch(error) {}
    }

    if (messagesToSend.length) {
      let tryCnt = 0;
      while (tryCnt < MAX_AUTOMATION_RETRY) {
        messagesToSend = await sendMessageOnCorrlinks(user['corrolinks_username'], user['corrolinks_password'], messagesToSend);
        if (messagesToSend.length == 0) {
          break;
        }

        tryCnt++;
      }
    }
  }
};

const handleTwilioToCorrlinks = async () => {
  let users = [];
  try {
    users = (await apiGet('/api/v1/user'))['data'];
  } catch(error) {
    return;
  }

  for (const user of users) {
    if (user['twilio_number'] == null) {
      continue;
    }

    const messages = await getTwilioMessages(formatPhoneNumber(user['twilio_number']));
    let messagesToSend = [];

    for (const message of messages) {
      try {
        let subject = getSubjectFromNumber(user, message['from']);

        if (subject == null) {
          const uuid_str = uuidv4();
          const parts = uuid_str.split('-');
          subject = parts[0] + parts[1].substring(0,2) + parts[2].substring(0,2) + parts[3].substring(0,2);

          await apiPost('/api/v1/contact/add/contact', {
            "inmate_email":user['corrolinks_username'],
            "contact_phone_number": message['from'],
            "contact_name": "Anonymous",
            "contact_keyword": subject
          });
        }

        messagesToSend.push({
          subject,
          message: message['body']
        });
      } catch(error) {}
    }

    if (messagesToSend.length) {
      let tryCnt = 0;
      while (tryCnt < MAX_AUTOMATION_RETRY) {
        messagesToSend = await sendMessageOnCorrlinks(user['corrolinks_username'], user['corrolinks_password'], messagesToSend);
        if (messagesToSend.length == 0) {
          break;
        }

        tryCnt++;
      }
    }
  }
};

const formatPhoneNumber = (phoneNumber) => {
  // If the number starts with "+1", do nothing
  if (phoneNumber.startsWith("+1")) {
    return phoneNumber;
  }

  // If the number starts with "1" but does not have a "+", add "+"
  if (phoneNumber.startsWith("1")) {
    return "+" + phoneNumber;
  }

  // If the number starts with any other digit, prepend "+1"
  return "+1" + phoneNumber;
};

const getNumberFromSubject = (user, subject) => {
  try {
    subject = subject.toLowerCase();

    for (const contact of user['contacts']) {
      if (contact['assigned_keyword'].toLowerCase() == subject) {
        return contact['phone_number'];
      }
    }
  } catch(error) {}

  return null;
};

const getSubjectFromNumber = (user, phone_number) => {
  try {
    for (const contact of user['contacts']) {
      if (formatPhoneNumber(contact['phone_number']) == phone_number) {
        return contact['assigned_keyword'];
      }
    }
  } catch(error) {}

  return null;
};

const getToken = async () => {
  try {
    const payload = {
      grant_type: 'client_credentials',
      client_secret: 'FX8ZTMiwI7cP2QgSxVNUBja0oogfXkteALVGHvuw',
      client_id: '9cc1b125-1ab3-4fcc-a276-0c3594d0590e',
    };

    const res = await axios.post(
      `${API_BASE_URL}/oauth/token`,
      payload,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );
    api_token = res?.data?.access_token;
  } catch (error) {
    logToFile(`Error while get token: ${error.toString()}`);
  }
};

const apiGet = async (url) => {
  if (api_token == '') {
    await getToken();
  }

  try {
    let res = await axios.get(`${API_BASE_URL}${url}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${api_token}`,
      },
    });

    if (res.status == 401) {
      await getToken();
      res = await axios.get(`${API_BASE_URL}${url}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${api_token}`,
        },
      });
    }

    return res?.data;
  } catch(error) {
    logToFile(`Error while api get: ${error.toString()}`);
    return null;
  }
};

const apiPost = async (url, payload) => {
  if (api_token == '') {
    await getToken();
  }

  try {
    let res = await axios.post(`${API_BASE_URL}${url}`, payload, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${api_token}`,
      },
    });

    if (res.status == 401) {
      await getToken();
      res = await axios.post(`${API_BASE_URL}${url}`, payload, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${api_token}`,
        },
      });
    }
    
    return res?.data;
  } catch(error) {
    logToFile(`Error while api post: ${error.toString()}`);
    return null;
  }
};

const saveTwilioLastRead = async () => {
  try {
    fs.writeFileSync("twilio_last_read", JSON.stringify(twilio_last_read));
  } catch(error) {}
};

(async () => {
  try {
    const str = fs.readFileSync("twilio_last_read", "utf8");
    twilio_last_read = JSON.parse(str);
  } catch(error) {}

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: googleApiKeyPath,
      scopes: ['https://www.googleapis.com/auth/gmail.modify']
    });

    const authClient = await auth.getClient();
    authClient.subject = 'catchall@withfath.com';
    catchAllGmail = google.gmail({ version: 'v1', auth: authClient });
  } catch (error) {
    logToFile(`Error while creating gmail api instance: ${error.toString()}`);
  }

  [`exit`, `SIGINT`, `uncaughtException`, `SIGTERM`].forEach((eventType) => {
    process.on(eventType, () => {
      log_file.close();
      process.exit();
    });
  });

  setInterval(handleCorrlinksToTwilio, CHECK_INTERVAL_C2T);
  setInterval(handleTwilioToCorrlinks, CHECK_INTERVAL_T2C);
  setInterval(saveTwilioLastRead, SAVE_INTERVAL_TWILIO_LASTREAD);
})();
