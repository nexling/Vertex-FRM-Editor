!***********************************************************************
!  Holeline_Rt         / 2001-01-17 / Vertex Systems
!
!  Rectangular Servicehole line, inserting form
!  changed to be used for sylomer.
!***********************************************************************
vxdbase_winstyle= VXUI
port_size= 0 0
revision= 2
status_bar=NONE !·style:·'NONE|FRAME|DIALOG',·status·bar·position.
!
header= {DAMPER}
!
text=  2  4 {TYPE}
text=  3  16 {WIDTH}
text=  3  22 {LENGTH}
!
field(1)=  "TYPE"   1+2  2 16 16 7 0 "path:sylomers"

field(2)=  "DX"     5  4   16   4  7 0
field(3)=  "DY"     5  4   22   4  7 0
field(4)=  "DZ"     1+4096  6   1000   5  7 0

field(5)=  "NOT_PERSISTANT" 5  7   1000  5  7 0

! Exo field is not part of the database. It's value is stored to the replarray.
! Name can't same as any of the fields of the database.
! Good practice is use $ as a prefix to differentiate it from the fields of the database.
! Exo field has field type +4096
field(6)= "$SYLOMER_TYPE"     1+4096 2  1000 16 0 0 0
field(7)= "$SYLOMER_THICK"    1+4096 6  1000 5 0 0 0

field(8)= "USE" 1 5 10 5 7 0
!
! Bottom bar buttons (row=100 indicates bottom bar placement)
button(1)= 100 0 0 {OK} $OK2
button(2)= 100 1 0 {CANCEL} $CANCEL2
button(3)= 100 2 0 {APPLY} $APPLY2
!
group(1)= 0 1 0 1 2 3 4 5 6 7 8
!
! This program just calls sylomer_type_size.prg
! Autotrigger executed after combo box selections
trigger= 1 sylomer_edit.prg p
!
! This program just calls sylomer_type_size.prg
! Autotrigger executed after edit box editing
trigger= 4 sylomer_edit.prg p

! this finds out what type sylomer it was before editing
! Trigger for initializing fields
trigger= $ONSTART2 sylomer_edit_start.prg p
!
! this checks if the type was changed and if so makes it permanent.
!·Trigger·executed·on·exit·after·dialog·is·closed.
trigger= $ONEXIT1 sylomer_edit_exit.prg p

