require('dotenv').config();

const fs      = require('fs');
const base64  = require('base64-stream');
const Imap    = require('imap');

let imap = new Imap({
    user: process.env.EMAIL_ADDR,
    password: process.env.EMAIL_PASSWORD,
    host: process.env.EMAIL_IMAP_HOST,
    port: 993,
    tls: true,
    //debug: function(msg) { console.log('imap-debug:', msg) },
})

let toUpper = (str) => { return str && str.toUpperCase ? str.toUpperCase() : str }

function findAttachmentParts(struct, attachments) {
    attachments = attachments ||  [];

    for (var i = 0, len = struct.length; i < len; ++i) {
        if (Array.isArray(struct[i])) {
            findAttachmentParts(struct[i], attachments);
        } 
        else {
            if (struct[i].disposition && ['INLINE', 'ATTACHMENT'].indexOf(toUpper(struct[i].disposition.type)) > -1) 
                attachments.push(struct[i]);
        }   
    }
    
    return attachments;
}

const targetDirectory = './incoming/';

function buildAttMessageFunction(attachment, uid) {
    let filename = attachment.params.name;
    let encoding = attachment.encoding;
    let msgUid = uid;

    if( filename ) filename = targetDirectory + filename;
    else return function() { /* do nothing */ }

    return function (msg, seqno) {
        let prefix = '(#' + seqno + ') ';

        msg.on('body', function(stream, info) {
            //Create a write stream so that we can stream the attachment to file;
            console.log(prefix + 'Streaming this attachment to file', filename, info);

            let writeStream = fs.createWriteStream(filename);

            writeStream.on('finish', function() {
                console.log(prefix + 'Done writing to file %s', filename);
            });

            if (toUpper(encoding) === 'BASE64') {
                //the stream is base64 encoded, so here the stream is decode on the fly and piped to the write stream (file)
                stream.pipe(new base64.Base64Decode()).pipe(writeStream);
            } 
            else {
                //here we have none or some other decoding streamed directly to the file which renders it useless probably
                stream.pipe(writeStream);
            }
        });

        msg.once('end', function() {
            console.log(prefix + 'Finished attachment %s', filename);

            imap.setFlags(msgUid, '\\Deleted', () => {
                console.log(`Email ${msgUid} has been marked for deletion.`);
            });
        });
    };
}

function processInbox() {
    imap.openBox('INBOX', false, function(err, box) {
        if (err) throw err;

        let f = imap.seq.fetch('1:' + box.messages.total, {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
            struct: true
        });

        f.on('message', function (msg, seqno) {
            console.log('Message #%d', seqno);

            var prefix = '(#' + seqno + ') ';

            msg.on('body', function(stream, info) {
                var buffer = '';

                stream.on('data', function(chunk) {
                    buffer += chunk.toString('utf8');
                });

                stream.once('end', function() {
                    console.log(prefix + 'Parsed header: %s', Imap.parseHeader(buffer));
                });
            });

            msg.once('attributes', function(attrs) {
                var attachments = findAttachmentParts(attrs.struct);

                console.log(prefix + 'Has attachments: %d', attachments.length);

                for (var i = 0, len=attachments.length; i < len; ++i) {
                    var attachment = attachments[i];

                    // Only interested in .wav files in this case:
                    if( toUpper(attachment.params.name).indexOf('.WAV') != -1 ) {
                        console.log(prefix + 'Fetching attachment %s', attachment.params.name);
                    }
                    else {
                        console.log(prefix + 'Skipping attachment %s...', attachment.params.name);
                        continue; // not a wav file, continue with for loop
                    }

                    let f = imap.fetch(attrs.uid , {   //do not use imap.seq.fetch here
                        bodies: [attachment.partID],
                        struct: true
                    });

                    //build function to process attachment message
                    f.on('message', buildAttMessageFunction(attachment, attrs.uid));
                }
            });

            msg.once('end', function() {
                console.log(prefix + 'Finished email...');
            });

        });

        f.once('error', function(err) {
            console.log('Fetch error: ' + err);
        });

        f.once('end', function() {
            console.log('Done fetching all messages!');

            setTimeout(() => imap.end(), 10 * 1000);
        });

    });
}

function openInbox() {
    return new Promise((resolve, reject) => {
        imap.openBox('INBOX', false, function(err, box) {
            if (err) reject(err);
            else resolve(box.messages.total > 0)         
        });        
    });
}

imap.once('ready', async function() {
    await openInbox()
        .then((msgsWaiting) => {
            if( msgsWaiting ) {
                imap.closeBox(true, (err) => { // closeBox(true) to ensure any deleted messages are purged.
                    if( err ) console.log(err);
                    processInbox(); // processInbox opens 'INBOX' as well
                })    
            }
            else imap.end();
        })
        .catch((err) => {
            if( err ) console.log(err);
            processInbox();
        });
});

imap.once('error', function(err) {
    console.log('IMAP ERROR: ')
    console.log(err);
});

imap.once('end', function() {
    console.log('Connection ended');
});

imap.connect();


/*This is how each attachment looks like {
    partID: '2',
    type: 'application',
    subtype: 'octet-stream',
    params: { name: 'file-name.ext' },
    id: null,
    description: null,
    encoding: 'BASE64',
    size: 44952,
    md5: null,
    disposition: { type: 'ATTACHMENT', params: { filename: 'file-name.ext' } },
    language: null
}
*/

