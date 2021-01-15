const allSettled = require("promise.allsettled");
const MongoClient = require("mongodb").MongoClient;
const IssueTso = require("@zowe/zos-tso-for-zowe-sdk").IssueTso;
const ZosmfSession = require("@zowe/zosmf-for-zowe-sdk").ZosmfSession;
const GetJobs = require("@zowe/zos-jobs-for-zowe-sdk").GetJobs;
const CancelJobs = require("@zowe/zos-jobs-for-zowe-sdk").CancelJobs;
const DeleteJobs = require("@zowe/zos-jobs-for-zowe-sdk").DeleteJobs;
const SubmitJobs = require("@zowe/zos-jobs-for-zowe-sdk").SubmitJobs;

const Z_IP = "192.86.32.153";
const Z_PORT = 10443;
const TSO_PROFILE = {
  account: "fb3",
  characterSet: "697",
  codePage: "1047",
  columns: 80,
  logonProcedure: "IZUFPROC",
  regionSize: 4096,
  rows: 24,
};
// limit on how many large messages may be sent for one job
const MAX_COMBINED_MSGS = 4;
allSettled.shim();

exports.handler = async (context, event, callback) => {
  const twiml = new Twilio.twiml.MessagingResponse();
  // check if we know the user and password for this sender
  const creds = await lookupCreds(event.From, context);

  // if we don't know prompt to enter credentials
  if (!creds && !event.Body.toLowerCase().startsWith("login")) {
    twiml.message(
      'I do not have credentials stored for this user! Please enter "login {user} {password}"'
    );

    return callback(null, twiml);
    // process login here so that command can be used without creds
  } else if (event.Body.toLowerCase().startsWith("login")) {
    // store given credentials
    const result = await storeCreds(event.From, event.Body, context);
    twiml.message(
      result ? "Credentials stored!" : "Login command format incorrect"
    );

    return callback(null, twiml);
  }

  // process commands for authenticated users
  switch (event.Body.split(" ")[0].toLowerCase()) {
    case "commands":
      twiml.message(`Commands:
      login <user> <pass> - Change login credentials
      logout - Delete login credentials
      tso <command> - Evaluate a tso command
      job search <prefix> - Search jobs
      job submit <dsn> - Submit a job
      job cancel <id> <name> - Cancel a job
      job delete <id> <name> - Delete a job`);
      break;
    case "login":
      const result = await storeCreds(event.From, event.Body, context);
      twiml.message(
        result ? "Credentials stored!" : "Login command format incorrect"
      );
      break;
    case "logout":
      await deleteCreds(event.From, context);
      twiml.message("Credentials removed!");
      break;
    case "tso":
      await runTSOCommand(
        event.Body,
        creds,
        context.getTwilioClient(),
        event.From
      );
      break;
    case "job":
      const jobCmd = event.Body.match(/job (search|submit|cancel|delete) (.+)/i);
      if (!jobCmd || jobCmd.length !== 3) {
        twiml.message("Job command format invalid!");
        break;
      }

      switch (jobCmd[1].toLowerCase()) {
        case "search":
          await searchJobs(
            jobCmd[2],
            creds,
            context.getTwilioClient(),
            event.From
          );
          break;
        case "cancel":
          twiml.message(await cancelJob(jobCmd[2], creds));
          break;
        case "delete":
          twiml.message(await deleteJob(jobCmd[2], creds));
          break;
        case "submit":
          twiml.message(await submitJob(jobCmd[2], creds));
          break;
        default:
          break;
      }
      break;
    default:
      twiml.message(
        'Unknown command. Please use one of "commands", "tso", "job", "login", or "logout"'
      );
      break;
  }

  return callback(null, twiml);
};

// Splits up messages that may be too big to send via the callback
async function sendMessage(message, client, numTo) {
  if (message.length > 1500) {
    // Loop through each chunk and send individually due to API limitations
    let messagePromises = [];
    for (let i = 0; i < Math.floor(message.length / 1500); i++) {
      const messageChunk = message.slice(i * 1500, (i + 1) * 1500);
      messagePromises.push(
        client.messages.create({
          body: messageChunk,
          from: "+17656000686",
          to: numTo,
        })
      );
      if (i >= MAX_COMBINED_MSGS) {
        break;
      }
    }
    await Promise.allSettled(messagePromises);
    return;
  } else {
    await client.messages.create({
      body: message,
      from: "+17656000686",
      to: numTo,
    });
    return;
  }
}

// Search for jobs (and statuses) by prefix
async function searchJobs(prefix, creds, client, numTo) {
  const zosmfProfile = {
    host: Z_IP,
    port: Z_PORT,
    user: creds.user,
    password: creds.pass,
    rejectUnauthorized: false,
    encoding: 0,
    responseTimeout: 600,
  };
  try {
    const session = ZosmfSession.createBasicZosmfSession(zosmfProfile);
    const results = await GetJobs.getJobsByPrefix(session, prefix);
    let message = [];
    if (results.length === 0) {
      message = ["No jobs found!"];
    } else {
      message = [`${results.length} Results:`];
      for (const job of results) {
        message.push(`${job.jobid} ${job.jobname} ${job.retcode || job.status}`);
      }
    }
    await sendMessage(message.join("\n"), client, numTo);
  } catch (e) {
    await sendMessage(e.toString(), client, numTo);
  }
}

async function cancelJob(cancelInfo, creds) {
  const zosmfProfile = {
    host: Z_IP,
    port: Z_PORT,
    user: creds.user,
    password: creds.pass,
    rejectUnauthorized: false,
    encoding: 0,
    responseTimeout: 600,
  };
  try {
    const session = ZosmfSession.createBasicZosmfSession(zosmfProfile);
    const jobId = cancelInfo.split(" ")[0];
    const jobName = cancelInfo.split(" ")[1];
    await CancelJobs.cancelJob(session, jobName, jobId);
    return "Job cancelled!";
  } catch (e) {
    return e.toString();
  }
}

async function deleteJob(delInfo, creds) {
  const zosmfProfile = {
    host: Z_IP,
    port: Z_PORT,
    user: creds.user,
    password: creds.pass,
    rejectUnauthorized: false,
    encoding: 0,
    responseTimeout: 600,
  };
  try {
    const session = ZosmfSession.createBasicZosmfSession(zosmfProfile);
    const jobId = delInfo.split(" ")[0];
    const jobName = delInfo.split(" ")[1];
    await DeleteJobs.deleteJob(session, jobName, jobId);
    return "Job deleted!";
  } catch (e) {
    return e.toString();
  }
}

// Submit job using DSN
async function submitJob(dsn, creds) {
  const zosmfProfile = {
    host: Z_IP,
    port: Z_PORT,
    user: creds.user,
    password: creds.pass,
    rejectUnauthorized: false,
    encoding: 0,
    responseTimeout: 600,
  };
  try {
    const session = ZosmfSession.createBasicZosmfSession(zosmfProfile);
    const job = await SubmitJobs.submitJob(session, dsn);
    return `Job ${job.jobid} with name ${job.jobname} created!`;
  } catch (e) {
    return e.toString();
  }
}

// Run a command in TSO
async function runTSOCommand(body, creds, client, numTo) {
  const command = body.slice(4);
  const zosmfProfile = {
    host: Z_IP,
    port: Z_PORT,
    user: creds.user,
    password: creds.pass,
    rejectUnauthorized: false,
    encoding: 0,
    responseTimeout: 600,
  };
  try {
    const session = ZosmfSession.createBasicZosmfSession(zosmfProfile);
    const response = await IssueTso.issueTsoCommand(
      session,
      TSO_PROFILE.account,
      command,
      TSO_PROFILE
    );
    if (response.success) {
      await sendMessage(response.commandResponse, client, numTo);
    } else {
      await sendMessage(`Error: ${JSON.stringify(response)}`, client, numTo);
    }
  } catch (e) {
    await sendMessage(e.toString(), client, numTo);
  }
}

// Get connection to authentication credential db
async function getAuthDb(context) {
  const uri = `mongodb+srv://mtm:${context.MONGO_PW}@cluster0.r4jq1.gcp.mongodb.net/?retryWrites=true&w=majority`;
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  await client.connect();
  const database = client.db("mtm");
  return database.collection("auth");
}

// Get a credential by phone number
async function lookupCreds(phoneNumber, context) {
  const collection = await getAuthDb(context);
  const user = await collection.findOne({ number: phoneNumber });
  return user;
}

// Store a credential by phone number
async function storeCreds(phoneNumber, body, context) {
  const loginInfo = body.match(/login (.+) (.+)/i);
  if (loginInfo.length !== 3) {
    return false;
  }

  const collection = await getAuthDb(context);
  await collection.replaceOne(
    { number: phoneNumber },
    {
      number: phoneNumber,
      user: loginInfo[1],
      pass: loginInfo[2],
    },
    { upsert: true }
  );
  return true;
}

// Remove a credential by phone number
async function deleteCreds(phoneNumber, context) {
  const collection = await getAuthDb(context);
  await collection.deleteOne({ number: phoneNumber });
}
