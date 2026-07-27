import sys
import extract_msg

msg_path = sys.argv[1]
out_path = sys.argv[2]

msg = extract_msg.Message(msg_path)
for a in msg.attachments:
    name = (a.longFilename or a.shortFilename or '').lower()
    if name.endswith('.pdf'):
        with open(out_path, 'wb') as f:
            f.write(a.data)
        print('OK')
        sys.exit(0)

print('NO_PDF_ATTACHMENT_FOUND')
sys.exit(1)
