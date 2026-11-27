!***********************************************************************
!  List view test form
!
!  page_listview makes the form a list: its non-exo fields are the table
!  columns, and the text with the same index is the column heading.
!  Covers: two tabs, a page_listview(0) fallback, opt_field columns,
!  an exo field drawn as a control, a field with width 0 (auto width),
!  decimal (10.2) and multi-line (50|3) widths, a missing heading and
!  columns that don't fit (scrollbar).
!***********************************************************************
vxdbase_winstyle= VXUI
port_size= 0 0
revision= 2
header= "Plates"
page_header(1)= "General"
page_header(2)= "Material"
page_header(3)= "Notes"
! Tab 2 has its own, shorter table; tabs 1 and 3 use the (0) table
page_listview(0)= 1 1 14 110 0
page_listview(2)= 4 1 11 110 1+2
filter_row= 1
!
! Column headings: row and column don't matter
text(1)= 0 0 "Name"
text(2)= 0 0 "Length"
text(3)= 0 0 "Width"
text(4)= 0 0 "Thick"
text(5)= 0 0 "Material"
text(6)= 0 0 "Grade"
text(7)= 0 0 "Remarks"
! No text(8): the heading falls back to the field name
! Text in front of the exo field (a control, so the text stays where it is)
text(20)= 2 1 "Plate text:"
!
! Columns shown on every tab, ordered by start column then index
field(1)= "NAME"      1 0 0 20 7 0
field(2)= "LENGTH"    1 0 5 10.2 7 0
field(3)= "WIDTH"     1 0 5 10.2 7 0
! Width 0: as wide as its heading
field(4)= "THICK"     1 0 9 0 7 0
! Columns of one tab only (opt_field)
field(5)= "MATERIAL"  1+2 0 0 16 7 0 "path:materials"
field(6)= "GRADE"     1 0 0 8 7 0
! On tab 3 the columns are wider than the table: the last one is cut off
field(7)= "REMARKS"   1 0 0 50|3 7 0
field(8)= "CREATED"   1 0 0 20 7 0
! Exo field: drawn as an edit box at its row/col, above tab 2's table
field(20)= "$PLATE_TEXT" 1+4096 2 13 25 0 0
!
group(1)= 1+2 2 0 1 2 3 4 5 6 7 8 20
!
opt_field(2)= 6 5 20
opt_field(3)= 7 8
opt_text(2)= 20
!
trigger= 20 plate_text.prg p
