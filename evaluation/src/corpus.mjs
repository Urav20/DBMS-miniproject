// Synthetic, original evidence wording. No real people, hosts or malware samples.
//
// 14 EVENT groups  : 8 records each. The first 4 use the group's canonical keywords ("kw"),
//                    the last 4 describe the SAME event in different words ("para").
//                    All 8 are relevant to the group's queries (grade 2).
// 6 TRAP groups    : harmless records that share vocabulary with an event group. Never relevant.
// FILLER templates : routine IT / office records. Never relevant.
//
// Slots filled per record from the seeded RNG: {host} {user} {ip} {n} {file} {day} {ref}
// Labels come from this structure (group membership), never from any search output.

export const EVENT_GROUPS = [
  {
    id: "G01", name: "Unsigned installer then beaconing", type: "Network capture", related: ["G12", "G13"],
    kw: {
      titles: ["Unsigned installer updater_setup.exe on {host}", "Beacon traffic from {host} to {ip}"],
      descs: [
        "An unsigned installer named updater_setup.exe was run on {host} and the host then started beacon connections to {ip} at regular intervals.",
        "Network review shows periodic beacon traffic from {host} to an unfamiliar external address {ip} beginning right after updater_setup.exe executed.",
      ],
      texts: ["09:14 process start updater_setup.exe user={user} unsigned=true; 09:16 outbound tcp {host} -> {ip}:443 beacon interval {n}s; ref {ref}"],
    },
    para: {
      titles: ["Workstation {host} repeatedly calling an unknown address", "Periodic outbound check-ins after a software download"],
      descs: [
        "After a user fetched a program from a public download page, the machine {host} began reaching out every few minutes to a remote system at {ip} that nobody in the department recognises.",
        "A freshly downloaded program with no valid publisher certificate started contacting an outside host at {ip} on a steady timer, as if reporting home.",
      ],
      texts: ["Connections observed: {host} to {ip} every {n} seconds, small payloads, same destination port; downloaded file lacks a publisher certificate; ref {ref}"],
    },
  },
  {
    id: "G02", name: "Phishing and credential harvesting", type: "Email message", related: ["G07"],
    kw: {
      titles: ["Phishing email with lookalike login page to {user}", "Credential harvesting link clicked by {user}"],
      descs: [
        "A phishing email directed {user} to a lookalike login page that captured the credentials typed into it.",
        "Mail export shows a phishing message linking to a credential harvesting page that imitates the company sign-in portal.",
      ],
      texts: ["From: it-support@example.com (spoofed) Subject: password expires today; link http://login.example.org/{ref}; form posts to {ip}; reply-to mismatch"],
    },
    para: {
      titles: ["Staff member received a fake sign-in request by email", "Message imitating the IT helpdesk asking for a password"],
      descs: [
        "An employee was sent a message pretending to be the helpdesk, which pushed them to a counterfeit website where they entered their username and password; the attacker received them.",
        "The message urged the recipient to confirm their account by signing in on a copy of the company portal hosted elsewhere, and the typed secrets were forwarded to a third party.",
      ],
      texts: ["Sender domain differs from the real company domain; the page asks for username and secret; submission goes to {ip}; recipient {user} opened it on {day}; ref {ref}"],
    },
  },
  {
    id: "G03", name: "Mass encryption with ransom note", type: "System log", related: ["G06"],
    kw: {
      titles: ["Ransom note and encrypted files on {host}", "Files renamed with .locked extension on {host}"],
      descs: [
        "A ransom note named READ_ME_NOW.txt appeared in every folder of {host} and the documents were encrypted and renamed with the .locked extension.",
        "File change log shows mass rewriting of documents into encrypted files with a .locked extension, followed by creation of a ransom note.",
      ],
      texts: ["{n} files modified in 90 seconds; new extension .locked; note READ_ME_NOW.txt demands payment in cryptocurrency; ref {ref}"],
    },
    para: {
      titles: ["Server {host} documents unreadable and payment demand displayed", "Sudden mass modification of user documents on {host}"],
      descs: [
        "Within minutes nearly all documents on the file server became unreadable, and a message on the screen asked the owner to send money to regain access.",
        "A burst of rewrites turned ordinary office files into scrambled data, and the affected machine showed a text demanding payment for a key.",
      ],
      texts: ["Hundreds of files changed within a short window, original names altered, a text file left behind describing how to pay; affected share {host}; ref {ref}"],
    },
  },
  {
    id: "G04", name: "Files copied to removable drive before resignation", type: "Registry export", related: ["G09", "G14"],
    kw: {
      titles: ["USB mass storage device connected to {host} before resignation", "Departing employee copied files to USB"],
      descs: [
        "Registry artifacts show a USB mass storage device attached to {host} the evening before {user} resigned, with a large set of copied files from the project share.",
        "Departing employee {user} plugged in a USB mass storage device and copied confidential files from the shared drive.",
      ],
      texts: ["USBSTOR entry first connected {day} 18:42; volume label BACKUP_{n}; file access log: {n} files read from fs01/projects within 11 minutes; ref {ref}"],
    },
    para: {
      titles: ["Flash drive used on {host} shortly before staff member left", "Large transfer of project documents onto removable media"],
      descs: [
        "Shortly before handing in notice, {user} attached a small flash drive to the desktop and moved a large collection of project documents onto it.",
        "Logs indicate an external memory stick was plugged in after hours and many internal documents were read and written to it by an employee who was about to leave the company.",
      ],
      texts: ["Removable volume mounted at 18:42 after hours; {n} documents from the projects share read then written to the external volume; account {user}; ref {ref}"],
    },
  },
  {
    id: "G05", name: "Browsing history wiped", type: "Browser history", related: ["G14", "G08"],
    kw: {
      titles: ["Cleared browser history on {host}", "Anti-forensic deletion of browser history by {user}"],
      descs: [
        "The user cleared browser history and cache on {host} minutes after the incident was reported, an anti-forensic step that left the history database empty.",
        "Anti-forensic activity: browser history deleted for all profiles of {user} and the session restore data purged.",
      ],
      texts: ["History file size reset to 0 at {day} 10:03; cache folder removed; cleanup tool launched by {user}; ref {ref}"],
    },
    para: {
      titles: ["Web-visit records erased from {host} soon after the alert", "Traces of web activity removed by the account holder"],
      descs: [
        "Not long after colleagues raised concerns, someone wiped the record of visited websites on the computer, leaving nothing to show what had been looked at.",
        "The account owner removed stored web activity data across the user profiles, so the list of pages visited before the alert can no longer be reconstructed from the machine.",
      ],
      texts: ["Visited-pages database truncated; temporary web files folder emptied; the removal ran under account {user} shortly after the alert; ref {ref}"],
    },
  },
  {
    id: "G06", name: "Recovery snapshots destroyed", type: "System log", related: ["G03"],
    kw: {
      titles: ["Volume shadow copies deleted on {host}", "Backup catalog removed from {host}"],
      descs: [
        "Command history shows volume shadow copies deleted and the backup catalog removed on {host}, eliminating local restore points.",
        "The system log records deletion of all volume shadow copies and removal of the backup catalog by {user}.",
      ],
      texts: ["vssadmin delete shadows /all executed by {user}; wbadmin delete catalog; restore points: 0 afterwards; ref {ref}"],
    },
    para: {
      titles: ["Recovery snapshots wiped from {host}", "Restore points eliminated by an unexpected command"],
      descs: [
        "An administrator-level command removed every saved recovery snapshot on the machine, so earlier states of the system can no longer be brought back.",
        "All point-in-time recovery data held locally was destroyed in one step, leaving no way to roll the computer back to an earlier day.",
      ],
      texts: ["Snapshot list empty after command run by {user} at {day} 02:11; no restore options remain for system drive; ref {ref}"],
    },
  },
  {
    id: "G07", name: "Password guessing then access", type: "System log", related: ["G02", "G10"],
    kw: {
      titles: ["Brute force and password spraying against {user}", "Burst of failed logins then success from {ip}"],
      descs: [
        "Authentication logs show a brute force pattern, with {n} failed logins from {ip} followed by one success for {user}.",
        "Password spraying detected: the same few passwords tried against many accounts from {ip}, ending in a successful login.",
      ],
      texts: ["failed logins {n} in 6 minutes src {ip}; accounts targeted 40; success for {user} at {day} 03:27; ref {ref}"],
    },
    para: {
      titles: ["Account of {user} opened after a flood of wrong attempts", "Repeated sign-in guesses from {ip} ended in access"],
      descs: [
        "A remote system kept guessing credentials for many accounts and eventually got into one of them after a long run of rejected attempts.",
        "Hundreds of rejected sign-in attempts from a single outside address were followed by an accepted one, which suggests the attacker found a working secret by trial.",
      ],
      texts: ["Rejected authentications {n} in a few minutes from {ip}; one accepted entry for {user} afterwards; ref {ref}"],
    },
  },
  {
    id: "G08", name: "Document properties tampered", type: "Document", related: ["G05"],
    kw: {
      titles: ["Document metadata modified and backdated", "Author field changed on {file}"],
      descs: [
        "Metadata analysis of {file} shows the creation date was backdated and the document author changed after the original was saved.",
        "The metadata modified timestamp precedes the creation time, a sign of backdated editing; the document author was also changed.",
      ],
      texts: ["created 2025-03-02; modified 2025-02-11 (earlier than created); author changed from {user} to admin; ref {ref}"],
    },
    para: {
      titles: ["Agreement file {file} carries dates that do not add up", "Properties of {file} edited to suggest a different time of writing"],
      descs: [
        "The stamps stored inside the agreement file are inconsistent and the listed writer differs from the original, indicating that someone tampered with the properties to suggest it was produced at an earlier time.",
        "Internal timestamps on the file contradict each other and the named originator was swapped, which points to deliberate manipulation of when and by whom it was produced.",
      ],
      texts: ["Stored timestamps out of order; originator name overwritten; file system dates reflect a copy made {day}; ref {ref}"],
    },
  },
  {
    id: "G09", name: "Bulk upload to external hosting", type: "Network capture", related: ["G12", "G04"],
    kw: {
      titles: ["Large archive uploaded to cloud storage from {host}", "Data exfiltration to personal cloud account"],
      descs: [
        "Proxy logs show a large archive uploaded to a personal cloud storage service from {host}, consistent with data exfiltration.",
        "Data exfiltration: {n} MB sent to an external cloud storage upload endpoint by {user} outside working hours.",
      ],
      texts: ["POST /upload size {n}MB host cloud-share.example.com user {user} 23:41; archive name docs_{n}.zip; ref {ref}"],
    },
    para: {
      titles: ["Unusually heavy outbound transfer from {host} to an online file locker", "Bulk send of internal files to an unapproved web service"],
      descs: [
        "Late in the evening a very large compressed bundle left the network for a consumer file-hosting site, much bigger than anything this person normally sends.",
        "The gateway recorded a sizeable package of internal material being pushed to a third-party online drive during off hours, well above normal volume for the account.",
      ],
      texts: ["Outbound volume {n}MB in one session to an external hosting site; compressed bundle; time 23:41; account {user}; ref {ref}"],
    },
  },
  {
    id: "G10", name: "Unauthorised elevation of rights", type: "System log", related: ["G07"],
    kw: {
      titles: ["Privilege escalation on {host}", "{user} added to administrators group"],
      descs: [
        "A privilege escalation event: {user} was added to the local administrators group on {host} without a change ticket.",
        "Security log 4732 shows {user} added to administrators group; local admin rights were then used to disable endpoint protection.",
      ],
      texts: ["member added to group Administrators by SYSTEM-level process; target {user}; host {host}; ref {ref}"],
    },
    para: {
      titles: ["Ordinary account on {host} suddenly holds elevated rights", "Unauthorised promotion of a standard user"],
      descs: [
        "A regular user account gained powers normally reserved for system managers on {host}, and nobody had requested the change.",
        "Without any approved request, a normal account was granted top-level control of the machine and then used that control to switch off protective software.",
      ],
      texts: ["Group membership changed at {day} 04:50; account {user} now has full control; initiating process ran as system; ref {ref}"],
    },
  },
  {
    id: "G11", name: "Auto-start mechanism for unknown program", type: "Registry export", related: ["G13", "G01"],
    kw: {
      titles: ["Scheduled task persistence on {host}", "Startup entry created by unknown program on {host}"],
      descs: [
        "A scheduled task named SystemHealthSync was created on {host} for persistence, launching a hidden executable at every logon.",
        "Persistence mechanism found: a new scheduled task and a startup entry run the same unknown program after each reboot.",
      ],
      texts: ["task SystemHealthSync created by {user}; action runs C:/ProgramData/{file} at logon; run-key added; ref {ref}"],
    },
    para: {
      titles: ["Hidden program set to relaunch every time {host} restarts", "Auto-run configuration added for an unfamiliar executable"],
      descs: [
        "Someone configured the computer so that an unfamiliar program would start again automatically whenever it was switched on, keeping a foothold in place.",
        "A background program was wired to come back on every boot and every sign-in, which would let an intruder stay inside even after the machine is turned off and on.",
      ],
      texts: ["Boot-time launch entries added for an executable in a shared data folder; relaunches at each sign-in; created {day}; ref {ref}"],
    },
  },
  {
    id: "G12", name: "Data hidden in name lookups", type: "Network capture", related: ["G01", "G09"],
    kw: {
      titles: ["DNS tunneling from {host}", "Long subdomain queries and TXT records to {ip}"],
      descs: [
        "DNS tunneling suspected: {host} issued thousands of long subdomain queries and TXT record lookups to a single domain.",
        "Resolver logs show DNS tunneling behaviour, with encoded long subdomain names and unusual TXT records returned from {ip}.",
      ],
      texts: ["queries/min 420 domain tunnel.example.net; avg label length 58; qtype TXT 91%; client {host}; ref {ref}"],
    },
    para: {
      titles: ["Name-lookup traffic from {host} carrying hidden data", "Abnormal domain lookups used as a covert channel"],
      descs: [
        "The resolver saw a single machine making an enormous number of lookups for oddly constructed names under one domain, which looks like data being smuggled inside ordinary name requests.",
        "Names in the lookups were long strings of random-looking characters and replies carried text payloads, a way of passing information past firewalls disguised as routine lookups.",
      ],
      texts: ["Client {host} sent about {n} lookups per minute to one zone; names are long encoded strings; responses larger than normal; ref {ref}"],
    },
  },
  {
    id: "G13", name: "Unapproved remote control software", type: "Disk image", related: ["G11", "G01"],
    kw: {
      titles: ["Remote desktop tool installed on {host}", "Unattended access software found on {host}"],
      descs: [
        "A remote desktop tool configured for unattended access was installed on {host} by {user} with no approval on file.",
        "Remote access software with an unattended access password was found running as a service on {host}.",
      ],
      texts: ["installer remote-desk-setup run by {user}; service RemoteDeskSvc auto-start; unattended access enabled; connection from {ip}; ref {ref}"],
    },
    para: {
      titles: ["Someone set up a way to control {host} from afar", "Third-party control program present on {host}"],
      descs: [
        "A program that lets a person operate the computer from another location was put on the machine and set to accept connections without anyone sitting at it, and no one had authorised it.",
        "The system hosts a background program allowing an outsider to take over the screen and keyboard whenever they like, installed outside the normal software approval route.",
      ],
      texts: ["Background service accepts inbound control sessions without a prompt; first session from {ip} at {day}; installed by {user}; ref {ref}"],
    },
  },
  {
    id: "G14", name: "Instruction to remove material before review", type: "Chat export", related: ["G05", "G04"],
    kw: {
      titles: ["Chat export: instruction to delete files", "Messages telling staff to destroy documents"],
      descs: [
        "A chat export contains an instruction to delete files and destroy documents related to the audit before investigators arrive.",
        "In the chat export, {user} gives an instruction to delete the shared folder and destroy documents.",
      ],
      texts: ["[{day} 17:20] {user}: delete the folder tonight and destroy documents on the printer; [17:22] ok will do; ref {ref}"],
    },
    para: {
      titles: ["Conversation urging colleagues to clear out material before the review", "Message thread directing removal of sensitive items"],
      descs: [
        "In a messaging thread one person tells co-workers to make the shared material vanish and shred the paper copies ahead of the inspection.",
        "A colleague is asked, in writing, to clear out everything that could look bad before the review team shows up, and agrees to do it that night.",
      ],
      texts: ["Thread {day}: sender asks recipients to purge shared folder and shred printed copies before the visit; recipients confirm; ref {ref}"],
    },
  },
];

// Harmless look-alikes: they reuse words from an event group but describe routine activity.
export const TRAP_GROUPS = [
  { id: "T01", mimics: "G06", type: "System log",
    titles: ["Nightly backup job completed on {host}", "Backup retention cleanup on {host}"],
    descs: [
      "The scheduled nightly backup copied {n} files to the archive server and deleted backups older than 30 days under the retention policy.",
      "Routine backup catalog maintenance removed expired restore points as configured; shadow copies are kept for seven days and no errors were reported.",
    ],
    texts: ["backup job nightly-{n} status OK; old backups deleted per policy; volume shadow copies maintained 7 days; catalog pruned; ref {ref}"] },
  { id: "T02", mimics: "G03", type: "System log",
    titles: ["Disk encryption enabled on {host}", "Encryption rollout status for {host}"],
    descs: [
      "IT enabled full disk encryption on {host} as part of the standard rollout; all files are encrypted at rest and the recovery key was escrowed.",
      "Encryption compliance report: encrypted files and volumes on {host} verified, with a note to rename the old drive label.",
    ],
    texts: ["volume C: protection ON; all files encrypted at rest; recovery key escrowed; ref {ref}"] },
  { id: "T03", mimics: "G07", type: "System log",
    titles: ["Failed logins after password change on {host}", "Helpdesk reset for {user}"],
    descs: [
      "User {user} had several failed logins after changing the password on a phone; the helpdesk reset the account and the next login worked.",
      "A short burst of failed logins came from the user's own laptop with a stale saved password; account unlocked by the helpdesk.",
    ],
    texts: ["failed logins {n}; account lockout; reset by helpdesk; success for {user} at {day}; ref {ref}"] },
  { id: "T04", mimics: "G04", type: "Document",
    titles: ["USB mass storage policy review for {host}", "Approved removable device inventory"],
    descs: [
      "Asset inventory lists the approved USB mass storage devices for the department, including encrypted drives issued by IT, with no unusual copied files flagged.",
      "Quarterly review of removable media policy: devices issued to {user} are registered; no departing employee cases this quarter.",
    ],
    texts: ["inventory: approved USB mass storage models; issued to {user}; copied files none flagged; ref {ref}"] },
  { id: "T05", mimics: "G02", type: "Email message",
    titles: ["Phishing awareness simulation results", "Training campaign summary for {user}'s department"],
    descs: [
      "The quarterly phishing simulation sent a test lookalike login page to staff; {n} clicked and were enrolled in training. No real credentials were collected.",
      "Awareness exercise: a mock credential harvesting page was used for training only; results are broken down by department.",
    ],
    texts: ["simulation campaign; credential harvesting page is a training mock; click rate by department; ref {ref}"] },
  { id: "T06", mimics: "G11", type: "Registry export",
    titles: ["Scheduled task for monthly patching on {host}", "Approved startup entries on {host}"],
    descs: [
      "The standard scheduled task that installs monthly updates runs at logon on {host}; it is part of the approved baseline, with a startup entry for the update agent.",
      "Baseline audit of {host}: scheduled task and startup entry lists match the approved image; no persistence mechanisms detected.",
    ],
    texts: ["task PatchAgent scheduled monthly; startup entry approved baseline; persistence mechanisms detected: none; ref {ref}"] },
];

export const FILLER_TEMPLATES = [
  { type: "System log", title: "Printer spooler log for {host}", descs: ["Spooler log showing {n} print jobs for {user} on {day}; no errors.", "Print queue summary for {host}: {n} jobs completed, one paper jam reported."], text: "spooler: job {n} user={user} pages={n} status=complete; ref {ref}" },
  { type: "Document", title: "Software inventory export for {host}", descs: ["Installed application list for {host} exported by the asset tool.", "Inventory of licensed applications on {host} for the annual review."], text: "apps: office suite, browser, pdf reader, vpn client, editor; licences valid; ref {ref}" },
  { type: "System log", title: "Antivirus scan report for {host}", descs: ["Weekly antivirus scan of {host} finished with no detections.", "Endpoint protection summary: {n} files scanned on {host}, zero threats."], text: "scan complete files={n} threats=0 duration={n}s; signatures current; ref {ref}" },
  { type: "System log", title: "Operating system update log on {host}", descs: ["Monthly operating system updates installed on {host} and a restart completed.", "Update history for {host} lists {n} patches applied successfully."], text: "update KB{n} installed; reboot pending cleared; ref {ref}" },
  { type: "Document", title: "Onboarding checklist for new hire {user}", descs: ["Checklist covering account creation, laptop setup and orientation for {user}.", "HR onboarding form for {user} with equipment and access requests ticked off."], text: "items: laptop issued, badge, mailbox, orientation {day}; ref {ref}" },
  { type: "Document", title: "Server uptime report for {host}", descs: ["Monthly availability report for {host}: uptime above target.", "Uptime and capacity summary for {host}, {n} minutes of planned maintenance."], text: "uptime 99.9 percent; cpu average low; disk usage {n} percent; ref {ref}" },
  { type: "Document", title: "Meeting minutes {day} for the {user} team", descs: ["Minutes of the weekly team meeting led by {user}, covering project schedule and holidays.", "Notes from the planning meeting on {day}; action items assigned for the next sprint."], text: "attendees {user}; agenda schedule, budget, holidays; next meeting in a week; ref {ref}" },
  { type: "Network capture", title: "VPN connection summary for {user}", descs: ["Normal VPN usage by {user} during office hours from the usual location.", "Daily remote access summary: {n} sessions, all from known addresses."], text: "vpn sessions {n} src known {ip} duration normal; no anomalies; ref {ref}" },
  { type: "Screenshot", title: "Dashboard screenshot from {host}", descs: ["Screenshot of the monitoring dashboard on {day} showing green status for all services.", "Capture of the capacity dashboard on {host} taken for the weekly report."], text: "image 1920x1080 dashboard widgets: cpu memory disk network all normal; ref {ref}" },
  { type: "Email message", title: "Calendar invitation from {user}", descs: ["Invitation to the quarterly review meeting sent by {user}.", "Meeting request for {day} with the facilities team, room booked."], text: "Subject: quarterly review; when {day} 14:00; where room {n}; ref {ref}" },
  { type: "Document", title: "Shared folder permissions listing for {host}", descs: ["Listing of group permissions on the department share hosted on {host}.", "Access control review for the marketing share; no changes since the last audit."], text: "share marketing: read=staff write=managers owner={user}; inherited; ref {ref}" },
  { type: "Email message", title: "Helpdesk ticket {n} from {user}", descs: ["Ticket asking for a larger monitor and a new keyboard for {user}.", "Request to move {user}'s desk phone to the new floor, closed after the move."], text: "ticket {n} category hardware status closed resolution done; ref {ref}" },
];

export const SLOT_POOLS = {
  users: ["Ana Ruiz", "Ben Okafor", "Chloe Park", "Dev Malhotra", "Elena Rossi", "Farid Haddad", "Grace Liu", "Hiro Tanaka", "Isla Murray", "Jonas Berg", "Kavya Nair", "Liam Walsh", "Mira Kapoor", "Noah Fischer", "Olga Petrova", "Pablo Reyes"],
  files: ["Q3_contract.docx", "supplier_agreement.pdf", "payroll_review.xlsx", "board_notes.docx", "svchost_helper.exe", "sync_agent.exe", "project_plan.docx", "audit_response.pdf"],
  days: ["2026-03-04", "2026-03-11", "2026-04-02", "2026-04-17", "2026-05-06", "2026-05-21", "2026-06-09", "2026-06-25"],
};
