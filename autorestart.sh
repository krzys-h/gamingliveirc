#!/bin/bash

while [ true ]; do
	node index.js
	echo The server has died, restarting...
	sleep 1
done
