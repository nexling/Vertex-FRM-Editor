// Keyword help shown by completion and hover.

export interface FrmKeyword {
  label: string;
  detail: string;
  documentation: string;
}

export const keywords: FrmKeyword[] = [
    {
        label: "vxdbase_winstyle",
        detail: `Sets format of window, either 'only' or 'VXUI'. Certain functions only work with one of the two styles.
dual database windows only work with VXUI and must then be set in both database forms.`,
        documentation: `Example:\n
\`\`\`vertexfrm
vxdbase_winstyle= VXUI
\`\`\`
Example2:\n
\`\`\`vertexfrm
vxdbase_winstyle= only
\`\`\`
`
    },
    {
        label: "header",
        detail: `Sets window header/title text.`,
        documentation: `Example:\n
\`\`\`vertexfrm
header = "window header"
\`\`\`
`
    },
    {
        label: "port_size",
        detail: `Sets the form's size, given in rows/columns. can be set to 0 0 to autosize based on content (sometimes does not size properly).`,
        documentation: `Example:\n
\`\`\`vertexfrm
port_size = 12 74
\`\`\`
Example2:\n
\`\`\`vertexfrm
port_size = rows columns
\`\`\`
`
    },
    {
        label: "text_font",
        detail: `Sets font to be used by texts in form, its set in numeric form, 5 is default font.`,
        documentation: `Example:\n
\`\`\`vertexfrm
text_font = 5
\`\`\`
`
    },
    {
        label: "field_font",
        detail: `Sets font to be used by texts inside fields in form, its set in numeric form, 5 is default font.`,
        documentation: `Example:\n
\`\`\`vertexfrm
field_font = 5
\`\`\`
`
    },
    {
        label: "has_pulldowns",
        detail: `vxdbase_winstyle = only: sets that window has pulldown menu along the top, if 1, 0 = no pulldown menu. File,Edit,Links,Show tabs are part of dropdown menu. 1 is default if nothing is set. does nothing if vxdbase_winstyle = VXUI.`,
        documentation: `Example:\n
\`\`\`vertexfrm
has_pulldowns = 1
has_pulldowns = 0
\`\`\`
`
    },
    {
        label: "ok_button",
        detail: `Sets if form has an OK button or not. 1 = has OK button, 0 = no OK button. 1 is default if nothing is set.`,
        documentation: `Example:\n
\`\`\`vertexfrm
ok_button = 1
ok_button = 0
\`\`\`
`
    },
    {
        label: "cancel_button",
        detail: `Sets if form has a Cancel button or not. 1 = has Cancel button, 0 = no Cancel button. 1 is default if nothing is set.`,
        documentation: `Example:\n
\`\`\`vertexfrm
cancel_button = 1
cancel_button = 0
\`\`\`
`
    },
    {
        label: "help_button",
        detail: `Sets if form has a Help button or not. 1 = has Help button, 0 = no Help button. 0 is default if nothing is set.`,
        documentation: `Example:\n
\`\`\`vertexfrm
help_button = 1
help_button = 0
\`\`\`
`
    },
    {
        label: "save_button",
        detail: `Sets if form has a Save button or not. 1 = has Save button, 0 = no Save button. 0 is default if nothing is set.`,
        documentation: `Example:\n
\`\`\`vertexfrm
save_button = 1
save_button = 0
\`\`\`
`
    },
    {
        label: "ok_label",
        detail: `Sets custom text for the OK button`,
        documentation: `Example:\n
\`\`\`vertexfrm
ok_label=  "ok_button_text"
\`\`\`
`
    },
    {
        label: "cancel_label",
        detail: `Sets custom text for the Cancel button`,
        documentation: `Example:\n
\`\`\`vertexfrm
cancel_label=  "cancel_button_text"
\`\`\`
`
    },
    {
        label: "help_label",
        detail: `Sets custom text for the Help button`,
        documentation: `Example:\n
\`\`\`vertexfrm
help_label=  "help_button_text"
\`\`\`
`
    },
    {
        label: "save_label",
        detail: `Sets custom text for the Save button`,
        documentation: `Example:\n
\`\`\`vertexfrm
save_label=  "save_button_text"
\`\`\`
`
    },
    {
        label: "help_file",
        detail: `Sets custom help file to open when pressing help button.`,
        documentation: `Example:\n
\`\`\`vertexfrm
help_file= helpfile.txt
\`\`\`
`
    },
    {
        label: "status_bar",
        detail: `NONE No status bar. 
FRAME The bottom of the frame/page. 
DIALOG The bottom of the dialog.`,
        documentation: `Example:\n
\`\`\`vertexfrm
status_bar= NONE
\`\`\`
`
    },
    {
        label: "page_header",
        detail: `Defines a tab inside a form and also the name of said tab.`,
        documentation: `Example:\n
\`\`\`vertexfrm
page_header(1) = "Tab1"
\`\`\`
Example2:\n
\`\`\`vertexfrm
page_header(tabindex) = "Tab Name"
\`\`\`
`
    },
    {
        label: "opt_text",
        detail: `keyword for defining text that should belong and only be visible to certain tab. texts that are not defined with opt_text will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_text(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_text(tabindex) = textindex1 textindex2 textindexn...
\`\`\`
`
    },
    {
        label: "opt_field",
        detail: `keyword for defining fields that should belong and only be visible to certain tab. fields that are not defined with opt_field will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_field(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_field(tabindex) = fieldindex1 fieldindex2 fieldindexn...
\`\`\`
`
    },
    {
        label: "opt_pushbutton",
        detail: `(OLD, use opt_button instead)keyword for defining pushbuttons that should belong and only be visible to certain tab. pushbuttons that are not defined with opt_pushbutton will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_pushbutton(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_pushbutton(tabindex) = pushbuttonindex1 pushbuttonindex2 pushbuttonindexn...
\`\`\`
`
    },
    {
        label: "opt_button",
        detail: `keyword for defining buttons that should belong and only be visible to certain tab. buttons that are not defined with opt_button will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_button(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_button(tabindex) = buttonindex1 buttonindex2 buttonindexn...
\`\`\`
`
    },
    {
        label: "opt_image",
        detail: `keyword for defining images that should belong and only be visible to certain tab. images that are not defined with opt_image will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_image(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_image(tabindex) = imageindex1 imageindex2 imageindexn...
\`\`\`
`
    },
    {
        label: "opt_bgimage",
        detail: `keyword for defining background images that should belong and only be visible to certain tab. background images that are not defined with opt_bgimage will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_bgimage(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_bgimage(tabindex) = imageindex1 imageindex2 imageindexn...
\`\`\`
`
    },
    {
        label: "opt_preview",
        detail: `keyword for defining preview windows that should belong and only be visible to certain tab. preview windows that are not defined with opt_preview will be shown on all tabs.`,
        documentation: `Example:\n
\`\`\`vertexfrm
opt_preview(1) = 1 2 3 4 5
\`\`\`
Example2:\n
\`\`\`vertexfrm
opt_preview(tabindex) = previewindex1 previewindex2 previewindexn...
\`\`\`
`
    },
    {
        label: "group",
        detail: `group defines selection order of fields, all fields must belong to a group, usually all fields belong to group 1, unsure what multiple groups are used for.
Types:
- 1 = Lines can be added
- 2 = Lines can be deleted
- 4 = Browse order will not change
- 8 = The specified browse order will be used
- 16 = The first predefined choice is the default when a line is inserted`,
        documentation: `Example:\n
\`\`\`vertexfrm
group(1)= 1+2 1 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20
\`\`\`
Example2:\n
\`\`\`vertexfrm
group(groupnr)= type RL field1 field2 fieldn...
\`\`\`
`
    },
    {
        label: "text",
        detail: `adds given text to form.`,
        documentation: `Example:\n
\`\`\`vertexfrm
text= 1 5 "Hello World"
\`\`\`
Example2:\n
\`\`\`vertexfrm
text(1)= 1 5 "Hello World"
\`\`\`
Example3:\n
\`\`\`vertexfrm
text(index)= row column "text"
\`\`\`
`
    },
    {
        label: "image",
        detail: `adds given image to form. Searches images from directory: forms/images/ if no $DIR path is given.
Types:
- +1   = no horizontal stretch
- +2   = no vertical stretch
- +64  = use alpha channel for transparency
- +128 = use top left corner for transparency
Supported file formats: BMP, JPG, TIF, GIF, PNG`,
        documentation: `Example:\n
\`\`\`vertexfrm
image(1)= 13 10 24 100 1+2 "image.png"
\`\`\`
Example2:\n
\`\`\`vertexfrm
image(index)= rowupperleftcorner columnupperleftcorner maxrowsize maxcolumnsize type "image-filename"
\`\`\`
`
    },
    {
        label: "bgimage",
        detail: `adds a background image or colour behind the form. Searches images from directory: forms/images/ if no $DIR path is given.
Several are drawn in index order, the highest on top. If a form has none, Vertex reads def_bg_*.vxf in the forms folder.
Width and height: pixels, -1 = fit to the area, 0 = the image's own size
Transparency: 0 = opaque, 255 = fully transparent
Modes:
- +64  = use alpha channel for transparency
- +128 = use top left corner for transparency
Placements:
- FRAME    = inside of the frame
- NOTFRAME = outside the frame (main database only)
- DIALOG   = full dialog (main database only)

Alignments: TOPLEFT, TOPMID, TOPRIGHT, MIDLEFT, MIDMID, MIDRIGHT, BOTTOMLEFT, BOTTOMMID, BOTTOMRIGHT, TILED
Instead of a file, "RGB(red,green,blue)" fills with a colour.
Supported file formats: BMP, JPG, TIF, GIF, PNG`,
        documentation: `Example:\n
\`\`\`vertexfrm
bgimage(1)= -1 -1 0 0 FRAME TOPLEFT "RGB(255,255,0)"
\`\`\`
Example2:\n
\`\`\`vertexfrm
bgimage(index)= width height transparency mode placement alignment "image-filename"
\`\`\`
`
    },
    {
        label: "field",
        detail: `adds a field to the form.
Styles:
- +1 = Field is active, usually is set.
- +2 = user freetype disallowed, only dropdown options or buttons can set value to field.
- +4 = locked field, can not be modified by user or buttons or dropdown options.
- +8 = Value must be set to field before closing form is accepted. (cancelling form still works, saving won't work if field is empty)
- +16 = Field is unique, can not have the same value across multiple rows of database.
- +32 = Lower limit field in a selection screen
- +64 = Upper limit field in a selection screen
- +128 = Interrupt by pressing f3 (“Show”) is allowed
- +256 = The file associated with the previous operation (128) 
        will be retrieved from: 
        - the general directory if that is active 
        - the directory defined by the PROJ_ID in the active field
- +512 = The field will not be listed (hidden) (can not get this to work)
- +1024 = unsure
- +2048 = unsure
- +4096 = Exo field, not part of object/database
- +8192 = no frame around field.
- +16384 = text is right aligned inside field.
- +32768 = text is centered inside field.
- +65536 = unsure
- +131072 = unsure
- +262144 = unsure
- +524288 = unsure
`,
        documentation: `Example:\n
\`\`\`vertexfrm
field(1)= STUDC 1+4 4 17 12 4 "2x4" "2x6"
\`\`\`
Example2:\n
\`\`\`vertexfrm
field(index)= fieldname style row column length type "prefill_opt1" "prefill_optn..."
\`\`\`
Example3:\n
\`\`\`vertexfrm
field(index)= fieldname style row column length type "path:filename with prefill options"
\`\`\`
`
    },
    {
        label: "pushbutton",
        detail: `adds a button to the form. (old format, should use button instead)`,
        documentation: `Example:\n
\`\`\`vertexfrm
pushbutton(13)=  2 26  {SEL}    @WALL.FRM.SEL.COND(TTYPE);TPL P\n ;!"makes button user can click to run given command/file/filesection"
pushbutton(index)= row column "textinbutton" "@ADTFILETORUN(INPUTPARAM1,INPUTPARAM2...);SectionOfADTFileToRun Type of program:C/P"
\`\`\`
Example2:\n
\`\`\`vertexfrm
pushbutton(5)=   9 16  {FROM_RIGHT}   RADIO STUD_DIR=1 DEFAULT\n !"makes little button user can select to set field to given value"
pushbutton(5)=   9 16  {FROM_RIGHT}   RADIO STUD_DIR=1\n
pushbutton(index)=   row column "text to right of button" RADIO FIELD=VALUE [DEFAULT] "optional: sets this RADIO button as default ticked"
\`\`\`
Example3:\n
\`\`\`vertexfrm
pushbutton(20)=  9  4  {HORIZ}  CHECKBOX BLK_ON=1;0\n ;!"makes checkbox user can toggle on/off to set given values to field"
pushbutton(index)= row column "text to right of button" CHECKBOX FIELD=VALUEwhenON;VALUEwhenOFF
\`\`\``
    },
    {
        label: "button",
        detail: `adds a button to the form.`,
        documentation: `Example:\n
\`\`\`vertexfrm
button(13)=  2 26  {SEL}    @WALL.FRM.SEL.COND(TTYPE);TPL P\n ;!"makes button user can click to run given command/file/filesection"
button(index)= row column "textinbutton" "@ADTFILETORUN(INPUTPARAM1,INPUTPARAM2...);SectionOfADTFileToRun Type of program:C/P"
\`\`\`
Example2:\n
\`\`\`vertexfrm
button(5)=   9 16  {FROM_RIGHT}   RADIO STUD_DIR=1 DEFAULT\n !"makes little button user can select to set field to given value"
button(5)=   9 16  {FROM_RIGHT}   RADIO STUD_DIR=1\n
button(index)=   row column "text to right of button" RADIO FIELD=VALUE [DEFAULT] "optional: sets this RADIO button as default ticked"
\`\`\`
Example3:\n
\`\`\`vertexfrm
button(20)=  9  4  {HORIZ}  CHECKBOX BLK_ON=1;0\n ;!"makes checkbox user can toggle on/off to set given values to field"
button(index)= row column "text to right of button" CHECKBOX FIELD=VALUEwhenON;VALUEwhenOFF
\`\`\``
    },
    { //checkbox
        label: "CHECKBOX",
        detail: `adds a checkbox to the form.`,
        documentation: `Example:\n
\`\`\`vertexfrm
pushbutton(20)=  9  4  {HORIZ}  CHECKBOX BLK_ON=1;0\n ;!"makes checkbox user can toggle on/off to set given values to field"
pushbutton(index)= row column "text to right of button" CHECKBOX FIELD=VALUEwhenON;VALUEwhenOFF
\`\`\``
    },
    { //radio
        label: "RADIO",
        detail: `adds a radio button to the form.`,
        documentation: `Example:\n
\`\`\`vertexfrm
pushbutton(5)=   9 16  {FROM_RIGHT}   RADIO STUD_DIR=1 DEFAULT\n !"makes little button user can select to set field to given value"
pushbutton(5)=   9 16  {FROM_RIGHT}   RADIO STUD_DIR=1\n
pushbutton(index)=   row column "text to right of button" RADIO FIELD=VALUE [DEFAULT] "optional: sets this RADIO button as default ticked"
\`\`\``
    },
    { //TRIGGER
        label: "trigger",
        detail: `Adds a trigger that is run on certain field/condition.`,
        documentation: `Example:\n
\`\`\`vertexfrm
trigger= 1 fastiron_trigger(TYPE) p/onstart
trigger= 1 fastiron_trigger p
trigger= fieldno programname(INPUTPARAMs) type/extracondition
\`\`\``
    },
];
